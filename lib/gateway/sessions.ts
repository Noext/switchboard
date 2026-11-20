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
 * The registry is process-local: sessions never survive a restart, which is exactly what the
 * spec wants — an unknown `Mcp-Session-Id` answers 404 and the client re-initializes.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config";
import { emitUiEvent } from "../events";
import { logger } from "../logs";
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
  if (session) session.lastSeenAt = Date.now();
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
  emitUiEvent("session.changed", { action: "update", session: toSummary(session) });
}

/** Closes one session. Safe for an unknown id; never throws. */
export async function closeSession(sessionId: string, reason = "closed"): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;
  sessions.delete(sessionId);
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
    void sweepIdleSessions().catch((error) => logger.warn({ err: String(error) }, "session janitor failed"));
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
export async function closeAllSessions(reason = "shutdown"): Promise<void> {
  stopSessionJanitor();
  const ids = [...sessions.keys()];
  await Promise.all(ids.map((id) => closeSession(id, reason)));
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
