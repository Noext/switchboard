/**
 * Gateway session registry (spec §6.1).
 *
 * One MCP session = one `StreamableHTTPServerTransport` + one SDK `Server` bound to a client
 * key. Sessions are created when a client initializes on `POST /mcp` and destroyed when:
 *   - the client sends `DELETE /mcp`,
 *   - the key is revoked / expires (lib/gateway/push.ts),
 *   - the session stayed idle for 24 h (this background janitor),
 *   - the process shuts down.
 *
 * ## Surviving a restart
 *
 * The live objects (server, transport, SSE sockets, in-flight requests) are process memory, so a
 * restart necessarily drops them. The session *identity* is persisted in SQLite instead
 * (lib/gateway/session-store.ts), and `rehydrateSession()` rebuilds a working session for an id
 * the client still holds. A deploy therefore no longer forces every open agent to re-initialize.
 *
 * Closed sessions are deleted from the store, so a persisted row always means "still valid".
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config";
import { emitUiEvent } from "../events";
import { logger } from "../logs";
import {
  deleteSession as deletePersistedSession,
  deleteSessionsForKey,
  loadSession,
  persistClientInfo,
  persistSubscriptions,
  pruneIdleSessions,
  saveSession,
  touchPersistedSession,
  type PersistedSession,
} from "./session-store";
import type { ExposureMode } from "../types";

/**
 * State needed by the MCP request handlers. Created before the SDK `Server` (the handlers close
 * over it), so it must not reference the server or the transport.
 */
export interface GatewaySessionState {
  sessionId: string;
  keyId: string;
  keyName: string;
  exposureMode: ExposureMode;
  ip: string | null;
  clientInfo: Implementation | null;
  createdAt: number;
  lastSeenAt: number;
  /** Resource URIs this client subscribed to (original upstream URIs). */
  subscriptions: Set<string>;
}

/**
 * The subset of a transport the registry needs. Keeping this structural (instead of the concrete
 * StreamableHTTPServerTransport) lets tests drive sessions over the SDK's InMemoryTransport too;
 * over HTTP the `handleRequest` method is present and unused here.
 */
export interface ClosableTransport {
  close(): Promise<void>;
  handleRequest?(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void>;
}

/** A registered session: its state plus the objects that must be closed with it. */
export interface GatewaySession extends GatewaySessionState {
  server: Server;
  transport: ClosableTransport;
}

export interface CreateSessionInput {
  sessionId: string;
  keyId: string;
  keyName: string;
  exposureMode: ExposureMode;
  ip: string | null;
}

/**
 * Shape consumed by the admin status endpoint (lib/api/status-hooks.ts).
 * The index signature keeps it structurally assignable to `SessionSummary` there.
 */
export interface SessionSummary {
  id: string;
  sessionId: string;
  keyId: string;
  keyName: string;
  clientName: string | null;
  clientVersion: string | null;
  ip: string | null;
  since: number;
  lastSeenAt: number;
  exposureMode: ExposureMode;
  [key: string]: unknown;
}

const sessions = new Map<string, GatewaySession>();
let janitor: NodeJS.Timeout | null = null;

const IDLE_TIMEOUT_MS = () => Math.max(1, config.defaults.sessionIdleTimeoutHours) * 60 * 60 * 1000;
const JANITOR_INTERVAL_MS = 60_000;

/** Builds the handler-facing state for a new session (not yet registered). */
export function createSessionState(input: CreateSessionInput): GatewaySessionState {
  const now = Date.now();
  return {
    sessionId: input.sessionId,
    keyId: input.keyId,
    keyName: input.keyName,
    exposureMode: input.exposureMode,
    ip: input.ip,
    clientInfo: null,
    createdAt: now,
    lastSeenAt: now,
    subscriptions: new Set<string>(),
  };
}

/** Registers the state together with its connected server + transport. */
export function registerSession(
  state: GatewaySessionState,
  server: Server,
  transport: ClosableTransport,
): GatewaySession {
  const session: GatewaySession = { ...state, server, transport };
  sessions.set(state.sessionId, session);
  saveSession({
    sessionId: state.sessionId,
    keyId: state.keyId,
    keyName: state.keyName,
    exposureMode: state.exposureMode,
    ip: state.ip,
    clientName: state.clientInfo?.name ?? null,
    clientVersion: state.clientInfo?.version ?? null,
    subscriptions: [...state.subscriptions],
    createdAt: state.createdAt,
    lastSeenAt: state.lastSeenAt,
  });
  ensureJanitor();
  logger.info(
    { sessionId: state.sessionId, keyId: state.keyId, keyName: state.keyName, ip: state.ip },
    "MCP session opened",
  );
  emitUiEvent("session.changed", { action: "open", session: toSummary(session) });
  return session;
}

/** Convenience wrapper used by tests and simple callers. */
export function createSession(
  input: CreateSessionInput,
  server: Server,
  transport: ClosableTransport,
): GatewaySession {
  return registerSession(createSessionState(input), server, transport);
}

export function getSession(sessionId: string): GatewaySession | null {
  return sessions.get(sessionId) ?? null;
}

export function hasSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/** Records activity for the idle timeout. Cheap enough to call on every HTTP request. */
export function touch(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  const now = Date.now();
  session.lastSeenAt = now;
  touchPersistedSession(sessionId, now);
}

/** Satisfies the "lastSeenAt" field for a state object that is not registered yet. */
export function touchState(state: GatewaySessionState): void {
  state.lastSeenAt = Date.now();
}

/** Fills in the `clientInfo` reported during `initialize` (spec §7.1). */
export function setClientInfo(sessionId: string, info: Implementation | null): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.clientInfo = info;
  persistClientInfo(sessionId, info);
  emitUiEvent("session.changed", { action: "update", session: toSummary(session) });
}

/** Closes one session. Safe for an unknown id; never throws. */
export async function closeSession(sessionId: string, reason = "closed"): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    // Not in memory but possibly still persisted (a restart raced the close): drop the row too.
    deletePersistedSession(sessionId);
    return;
  }
  sessions.delete(sessionId);
  deletePersistedSession(sessionId);
  try {
    await session.server.close();
  } catch (error) {
    logger.debug({ sessionId, err: String(error) }, "MCP server close failed");
  }
  try {
    await session.transport.close();
  } catch (error) {
    logger.debug({ sessionId, err: String(error) }, "MCP transport close failed");
  }
  logger.info({ sessionId, keyId: session.keyId, reason }, "MCP session closed");
  emitUiEvent("session.changed", { action: "close", reason, session: toSummary(session) });
}

/** Closes every session opened with this key (spec §6.1: revocation closes sessions at once). */
export async function closeSessionsForKey(keyId: string, reason = "key-revoked"): Promise<number> {
  const ids = [...sessions.values()].filter((s) => s.keyId === keyId).map((s) => s.sessionId);
  await Promise.all(ids.map((id) => closeSession(id, reason)));
  // Also drop any persisted row for this key, including sessions this process never had in
  // memory (they would otherwise be rehydrated after a restart, defeating the revocation).
  deleteSessionsForKey(keyId);
  return ids.length;
}

export function listSessions(): GatewaySession[] {
  return [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function sessionsForKey(keyId: string): GatewaySession[] {
  return listSessions().filter((s) => s.keyId === keyId);
}

export function sessionCount(): number {
  return sessions.size;
}

export function toSummary(session: GatewaySessionState): SessionSummary {
  return {
    id: session.sessionId,
    sessionId: session.sessionId,
    keyId: session.keyId,
    keyName: session.keyName,
    clientName: session.clientInfo?.name ?? null,
    clientVersion: session.clientInfo?.version ?? null,
    ip: session.ip,
    since: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    exposureMode: session.exposureMode,
  };
}

/** Closes sessions idle for longer than the configured timeout (spec §6.1: 24 h). */
export async function sweepIdleSessions(now = Date.now()): Promise<number> {
  const cutoff = now - IDLE_TIMEOUT_MS();
  const idle = [...sessions.values()].filter((s) => s.lastSeenAt < cutoff).map((s) => s.sessionId);
  await Promise.all(idle.map((id) => closeSession(id, "idle-timeout")));
  return idle.length;
}

/** Starts the background janitor (idempotent). The timer is unref'd so tests can exit. */
export function ensureJanitor(): void {
  if (janitor) return;
  janitor = setInterval(() => {
    void sweepIdleSessions()
      .then(() => prunePersistedIdleSessions())
      .catch((error) => logger.warn({ err: String(error) }, "session janitor failed"));
  }, JANITOR_INTERVAL_MS);
  if (typeof janitor.unref === "function") janitor.unref();
}

export function stopSessionJanitor(): void {
  if (janitor) {
    clearInterval(janitor);
    janitor = null;
  }
}

/** Graceful shutdown: closes every session and stops the janitor. */
/**
 * Detaches every live session on shutdown.
 *
 * A graceful stop must NOT delete the persisted rows: those rows are precisely what lets a
 * restarted process rehydrate the clients that are still connected. Only the in-memory objects
 * are torn down. Genuine closes (client DELETE, revocation, idle timeout) go through
 * `closeSession` instead, which does delete the row.
 *
 * `reason === "shutdown"` keeps the rows; any other reason (tests, forced teardown) deletes them.
 */
export async function closeAllSessions(reason = "shutdown"): Promise<void> {
  stopSessionJanitor();
  const keepRows = reason === "shutdown";
  const all = [...sessions.values()];
  sessions.clear();
  for (const session of all) {
    try {
      await session.server.close();
    } catch (error) {
      logger.debug({ sessionId: session.sessionId, err: String(error) }, "MCP server close failed");
    }
    try {
      await session.transport.close();
    } catch (error) {
      logger.debug({ sessionId: session.sessionId, err: String(error) }, "MCP transport close failed");
    }
    if (!keepRows) deletePersistedSession(session.sessionId);
    emitUiEvent("session.changed", { action: "close", reason, session: toSummary(session) });
  }
  logger.info({ count: all.length, reason, persistedRowsKept: keepRows }, "all MCP sessions detached");
}

// ---------------------------------------------------------------------------------------------
// Restart recovery
// ---------------------------------------------------------------------------------------------

/**
 * Registers an already-built session for a persisted id (see lib/gateway/http.ts, which owns the
 * SDK object construction). Used only when a client presents a session id this process did not
 * create — i.e. after a restart.
 */
export function registerRehydratedSession(input: {
  sessionId: string;
  keyId: string;
  keyName: string;
  exposureMode: ExposureMode;
  ip: string | null;
  clientInfo: Implementation | null;
  subscriptions: string[];
  createdAt: number;
  server: Server;
  transport: ClosableTransport;
}): GatewaySession {
  const now = Date.now();
  const state: GatewaySessionState = {
    sessionId: input.sessionId,
    keyId: input.keyId,
    keyName: input.keyName,
    exposureMode: input.exposureMode,
    ip: input.ip,
    clientInfo: input.clientInfo,
    createdAt: input.createdAt,
    lastSeenAt: now,
    subscriptions: new Set(input.subscriptions),
  };
  const session: GatewaySession = { ...state, server: input.server, transport: input.transport };
  sessions.set(input.sessionId, session);
  touchPersistedSession(input.sessionId, now);
  ensureJanitor();
  logger.info(
    { sessionId: input.sessionId, keyId: input.keyId, keyName: input.keyName },
    "MCP session rehydrated after restart",
  );
  emitUiEvent("session.changed", { action: "open", rehydrated: true, session: toSummary(session) });
  return session;
}

/** Persisted (still-valid) session row for an id, or null. */
export function persistedSession(sessionId: string): PersistedSession | null {
  return loadSession(sessionId);
}

/** Records the subscription set so a restart can restore `resources/subscribe` state. */
export function rememberSubscriptions(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  persistSubscriptions(sessionId, [...session.subscriptions]);
}

/** Drops persisted rows for sessions idle past the timeout (mirrors the in-memory sweep). */
export function prunePersistedIdleSessions(now = Date.now()): number {
  return pruneIdleSessions(now - IDLE_TIMEOUT_MS());
}

/** Test helper: drops the registry without going through the async close path. */
export function clearSessionsForTests(): void {
  for (const session of sessions.values()) {
    try {
      void session.server.close().catch(() => undefined);
    } catch {
      /* a stub server (tests) may not be closable */
    }
    try {
      void session.transport.close().catch(() => undefined);
    } catch {
      /* a stub transport (tests) may not be closable */
    }
  }
  sessions.clear();
  stopSessionJanitor();
}
