/**
 * HTTP layer of the gateway: the /mcp endpoint and the /healthz probe (spec §2.3, §6.1, §11.4).
 *
 * Kept apart from server.ts so the transport wiring is testable over a plain node:http server
 * (no Next.js needed): tests/gateway-http.test.ts mounts these handlers on an ephemeral port.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "../config";
import { logger } from "../logs";
import { authenticateSecret, KEY_PREFIX } from "../auth/keys";
import { getCatalogSnapshot } from "../catalog/catalog";
import { createUpstreamManager } from "../upstreams/manager";
import { getUpstreamManager, hasUpstreamManager } from "../upstreams/types";
import { SERVER_NAME, SERVER_VERSION } from "./meta";
import { primeKeyView } from "./push";
import { createGatewayServer } from "./server";
import {
  closeSession,
  createSessionState,
  getSession,
  listSessions,
  persistedSession,
  registerRehydratedSession,
  registerSession,
  toSummary,
  touch,
  type GatewaySession,
} from "./sessions";

export const MCP_PATH = config.mcpPath;

// ---------------------------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------------------------

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.end(payload);
}

export function requestIp(req: IncomingMessage): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) return forwarded.split(",")[0]!.trim();
  if (Array.isArray(forwarded) && forwarded.length > 0) return forwarded[0]!;
  return req.socket.remoteAddress ?? null;
}

export function bearerSecret(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const secret = match[1]!.trim();
  return secret.length > 0 ? secret : null;
}

export function sessionIdHeader(req: IncomingMessage): string | null {
  const raw = req.headers["mcp-session-id"];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw) && raw.length > 0) return raw[0] ?? null;
  return null;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return undefined;
  return JSON.parse(text) as unknown;
}

// ---------------------------------------------------------------------------------------------
// /healthz
// ---------------------------------------------------------------------------------------------

export interface HealthPayload {
  status: "ok" | "degraded";
  version: string;
  name: string;
  uptime: number;
  uptimeSeconds: number;
  sessions: number;
  upstreams: Record<string, { slug: string; status: string; lastError: string | null; tools: number }>;
  catalog: { version: number; builtAt: number; tools: number };
  timestamp: number;
}

/** Builds the /healthz payload. Never throws: an unhealthy subsystem degrades, it does not 500. */
export function buildHealthPayload(): HealthPayload {
  const upstreams: HealthPayload["upstreams"] = {};
  let status: HealthPayload["status"] = "ok";
  let catalog = { version: 0, builtAt: 0, tools: 0 };
  try {
    const snapshot = getCatalogSnapshot();
    catalog = { version: snapshot.version, builtAt: snapshot.builtAt, tools: snapshot.toolsByPublicName.size };
    for (const [upstreamId, view] of Object.entries(snapshot.upstreams)) {
      // Never `getManager()` here: it would *create* a manager and replace the registered one.
      const state = hasUpstreamManager() ? getUpstreamManager().getState(upstreamId) : null;
      const upstreamStatus = state?.status ?? view.status;
      upstreams[view.slug] = {
        slug: view.slug,
        status: upstreamStatus,
        lastError: state?.lastError ?? null,
        tools: view.tools.length,
      };
      if (upstreamStatus === "error" || upstreamStatus === "auth_required") status = "degraded";
    }
  } catch (error) {
    logger.warn({ err: String(error) }, "healthz could not read the catalog");
    status = "degraded";
  }

  const uptimeSeconds = Math.round(process.uptime());
  return {
    status,
    version: SERVER_VERSION,
    name: SERVER_NAME,
    uptime: uptimeSeconds,
    uptimeSeconds,
    sessions: listSessions().length,
    upstreams,
    catalog,
    timestamp: Date.now(),
  };
}

/** GET /healthz — unauthenticated by design (Uptime Kuma, Docker HEALTHCHECK). */
export function healthzHandler(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, buildHealthPayload());
}

// ---------------------------------------------------------------------------------------------
// /mcp
// ---------------------------------------------------------------------------------------------

export interface McpAuth {
  keyId: string;
  keyName: string;
  exposureMode: "direct" | "discovery";
}

/** Validates the Bearer key. Returns null after sending the failure response. */
export function authorizeMcp(req: IncomingMessage, res: ServerResponse): McpAuth | null {
  const secret = bearerSecret(req);
  if (!secret || !secret.startsWith(KEY_PREFIX)) {
    res.setHeader("www-authenticate", 'Bearer realm="switchboard"');
    sendJson(res, 401, { error: "missing_api_key", message: "En-tête Authorization: Bearer sk-sw-… requis." });
    return null;
  }
  let result: ReturnType<typeof authenticateSecret>;
  try {
    result = authenticateSecret(secret);
  } catch (error) {
    logger.warn({ err: String(error) }, "MCP authentication failed");
    sendJson(res, 401, { error: "invalid_api_key", message: "Clé API invalide." });
    return null;
  }
  if (!result.ok) {
    const messages: Record<typeof result.reason, string> = {
      missing: "En-tête Authorization requis.",
      invalid: "Clé API inconnue.",
      revoked: "Clé API révoquée.",
      expired: "Clé API expirée.",
    };
    res.setHeader("www-authenticate", 'Bearer realm="switchboard", error="invalid_token"');
    sendJson(res, 401, { error: result.reason, message: messages[result.reason] });
    return null;
  }
  if (result.key.scope === "admin") {
    sendJson(res, 403, {
      error: "forbidden",
      message: "Une clé de portée admin ne peut pas utiliser /mcp : elle sert uniquement à l'API d'administration.",
    });
    return null;
  }
  return { keyId: result.key.id, keyName: result.key.name, exposureMode: result.key.exposureMode };
}

/** Creates a stateful transport + gateway server pair for a brand-new session. */
export async function openSession(auth: McpAuth, ip: string | null): Promise<GatewaySession> {
  const provisionalId = randomUUID();
  const state = createSessionState({
    sessionId: provisionalId,
    keyId: auth.keyId,
    keyName: auth.keyName,
    exposureMode: auth.exposureMode,
    ip,
  });

  const server = createGatewayServer(state);
  let registered: GatewaySession | null = null;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // SDK-native SSE keep-alive: comment frames on idle GET streams (spec §11.4).
    keepAliveMs: config.defaults.sseKeepAliveMs,
    onsessioninitialized: (sessionId: string) => {
      // The transport assigns the real id (and calls this) while handling `initialize`.
      state.sessionId = sessionId;
      registered = registerSession(state, server, transport);
      // Snapshot the key's view so the next catalog change can be diffed and pushed (§5).
      primeKeyView(state.keyId);
    },
    onsessionclosed: (sessionId: string) => {
      void closeSession(sessionId, "client-delete").catch((error: unknown) =>
        logger.warn({ sessionId, err: String(error) }, "session close failed"),
      );
    },
  });

  transport.onerror = (error: Error) => {
    logger.warn({ sessionId: transport.sessionId ?? provisionalId, err: String(error) }, "MCP transport error");
  };

  await server.connect(transport);
  // `registered` is set by onsessioninitialized during handleRequest; the provisional session is
  // returned here so callers always have the pair to close on failure.
  return (
    registered ?? { ...state, server, transport }
  );
}

/** Routes a /mcp request: auth, session resolution, initialize/stream/delete. */
// ---------------------------------------------------------------------------------------------
// Restart recovery
// ---------------------------------------------------------------------------------------------

/**
 * Rebuilds a live session for an id this process does not hold in memory.
 *
 * The SDK transport refuses any non-initialize request until it believes it has been initialised
 * and owns the session id. A fresh transport is what the SDK expects when a request arrives for a
 * session it has not seen in this process, so we seed those two internal flags from the persisted
 * row and connect a fresh `Server`. Everything the handlers read (catalog, effective access,
 * prompts) comes from the database, so the rebuilt session serves the same view as the original.
 *
 * Returns null when there is no valid persisted row, or it belongs to another key.
 */
export async function rehydrateSession(
  sessionId: string,
  auth: McpAuth,
  ip: string | null,
): Promise<GatewaySession | null> {
  const persisted = persistedSession(sessionId);
  if (!persisted) return null;
  // A session never changes owner: a different key presenting the id is not a restart.
  if (persisted.keyId !== auth.keyId) return null;

  const state = createSessionState({
    sessionId: persisted.sessionId,
    keyId: persisted.keyId,
    keyName: persisted.keyName,
    exposureMode: persisted.exposureMode,
    ip: persisted.ip ?? ip,
  });
  state.createdAt = persisted.createdAt;
  state.subscriptions = new Set(persisted.subscriptions);

  const server = createGatewayServer(state);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => persisted.sessionId,
    keepAliveMs: config.defaults.sseKeepAliveMs,
  });

  // Seed the transport's view: it must consider the session initialised and owned.
  const inner = (transport as unknown as {
    _webStandardTransport?: { _initialized?: boolean; sessionId?: string };
  })._webStandardTransport;
  if (!inner) {
    logger.warn({ sessionId }, "cannot rehydrate: transport internals unavailable");
    return null;
  }
  inner._initialized = true;
  inner.sessionId = persisted.sessionId;

  transport.onerror = (error: Error) => {
    logger.warn({ sessionId, err: String(error) }, "MCP transport error (rehydrated)");
  };

  await server.connect(transport);
  return registerRehydratedSession({
    sessionId: persisted.sessionId,
    keyId: persisted.keyId,
    keyName: persisted.keyName,
    exposureMode: persisted.exposureMode,
    ip: persisted.ip ?? ip,
    clientInfo:
      persisted.clientName || persisted.clientVersion
        ? { name: persisted.clientName ?? "unknown", version: persisted.clientVersion ?? "unknown" }
        : null,
    subscriptions: persisted.subscriptions,
    createdAt: persisted.createdAt,
    server,
    transport,
  });
}

export async function mcpHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const auth = authorizeMcp(req, res);
  if (!auth) return;

  const requestedSessionId = sessionIdHeader(req);
  const existing = requestedSessionId ? getSession(requestedSessionId) : null;

  if (existing) {
    // A session never changes owner: a different key presenting the id is rejected (§6.1).
    if (existing.keyId !== auth.keyId) {
      sendJson(res, 401, { error: "session_mismatch", message: "Cette session appartient à une autre clé API." });
      return;
    }
    if (method === "DELETE") {
      await closeSession(existing.sessionId, "client-delete");
      res.statusCode = 200;
      res.end();
      return;
    }
    touch(existing.sessionId);
    const handler = existing.transport.handleRequest;
    if (!handler) {
      sendJson(res, 500, { error: "internal_error", message: "Transport MCP incompatible." });
      return;
    }
    await handler.call(existing.transport, req, res);
    return;
  }

  // A session id this process does not hold may still be a valid session that predates a
  // restart. Rebuild it from the persisted row rather than answering 404, so open agents survive
  // a deploy instead of re-initializing.
  if (requestedSessionId) {
    const rehydrated = await rehydrateSession(requestedSessionId, auth, requestIp(req));
    if (rehydrated) {
      if (method === "DELETE") {
        await closeSession(rehydrated.sessionId, "client-delete");
        res.statusCode = 200;
        res.end();
        return;
      }
      const handler = rehydrated.transport.handleRequest;
      if (!handler) {
        sendJson(res, 500, { error: "internal_error", message: "Transport MCP incompatible." });
        return;
      }
      await handler.call(rehydrated.transport, req, res);
      return;
    }
    sendJson(res, 404, { error: "session_not_found", message: "Session MCP inconnue : réinitialise la connexion." });
    return;
  }

  if (method !== "POST") {
    sendJson(res, 400, {
      error: "missing_session",
      message: "En-tête Mcp-Session-Id requis (ou POST /mcp avec une requête initialize).",
    });
    return;
  }

  // A POST without a session must be an initialize request; anything else is a client bug.
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { error: "parse_error", message: "Corps de requête JSON invalide." });
    return;
  }
  const messages = Array.isArray(body) ? body : body === undefined ? [] : [body];
  const isInit = messages.some((message) => isInitializeRequest(message));
  if (!isInit) {
    sendJson(res, 400, {
      error: "missing_session",
      message: "En-tête Mcp-Session-Id requis : envoie d'abord une requête initialize.",
    });
    return;
  }

  try {
    const session = await openSession(auth, requestIp(req));
    // The body was consumed above, so hand it to the transport pre-parsed.
    const handler = session.transport.handleRequest;
    if (!handler) {
      sendJson(res, 500, { error: "internal_error", message: "Transport MCP incompatible." });
      return;
    }
    await handler.call(session.transport, req, res, body);
  } catch (error) {
    logger.error({ err: String(error) }, "MCP initialize failed");
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal_error", message: "Échec de l'initialisation de la session MCP." });
    }
  }
}

/** Session summaries for the admin status endpoint (registered from server.ts at boot). */
export function sessionSummaries() {
  return listSessions().map(toSummary);
}

/** Boots the upstream manager; a broken upstream never prevents the gateway from starting. */
export async function startUpstreams(): Promise<void> {
  try {
    const manager = createUpstreamManager();
    await manager.startAll();
    logger.info({ upstreams: manager.getAllStates().length }, "upstream manager started");
  } catch (error) {
    logger.error({ err: String(error) }, "upstream manager failed to start");
  }
}
