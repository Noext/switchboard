/**
 * Custom Node server (spec §2.3, §6.1, §11.4).
 *
 *   /mcp      -> MCP gateway (stateful Streamable HTTP, one SDK Server per session)
 *   /healthz  -> unauthenticated JSON health probe (Uptime Kuma, Docker HEALTHCHECK)
 *   *         -> Next.js (next({ dev }) + getRequestHandler())
 *
 * The HTTP transport wiring lives in lib/gateway/http.ts (so it can be tested over a plain
 * node:http server); this file only boots the process: DB/catalog, upstream manager, catalog
 * push, Next, and graceful shutdown.
 *
 * SSE keep-alive: each transport is created with keepAliveMs: 25_000, which makes the SDK write
 * SSE comment frames on idle GET streams — the safe way to survive a proxy idle timeout
 * (Traefik drops quiet connections, spec §11.4). We never write to res ourselves.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import next from "next";
import { config, ensureDataDir } from "./lib/config";
import { getDb, closeDb } from "./lib/db";
import { logger } from "./lib/logs";
import { getCatalogSnapshot } from "./lib/catalog/catalog";
import { registerSessionProvider } from "./lib/api/status-hooks";
import { closeAllSessions } from "./lib/gateway/sessions";
import { flushPushNow, startCatalogPush, stopCatalogPush } from "./lib/gateway/push";
import {
  MCP_PATH,
  healthzHandler,
  mcpHandler,
  sessionSummaries,
  startUpstreams,
} from "./lib/gateway/http";
import { getUpstreamManager, hasUpstreamManager } from "./lib/upstreams/types";

type NextApp = ReturnType<typeof next>;

// Next refuses to start twice in the same process; dev reloads re-import this module.
const NEXT_GLOBAL = Symbol.for("switchboard.next");
type GlobalWithNext = typeof globalThis & {
  [NEXT_GLOBAL]?: { app: NextApp; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> };
};

const dev = process.env.NODE_ENV !== "production";

// ---------------------------------------------------------------------------------------------
// Next.js (single instance per process, dev reload safe)
// ---------------------------------------------------------------------------------------------

/**
 * Returns the Next request handler, creating (and caching globally) the app on first use.
 * Next 16 requires `prepare()` before the handler can serve requests.
 */
export async function getNextHandler(): Promise<(req: IncomingMessage, res: ServerResponse) => Promise<void>> {
  const store = globalThis as GlobalWithNext;
  const existing = store[NEXT_GLOBAL];
  if (existing) return existing.handler;
  const app = next({ dev });
  await app.prepare();
  const handler = app.getRequestHandler();
  store[NEXT_GLOBAL] = { app, handler };
  return handler;
}

// ---------------------------------------------------------------------------------------------
// Boot / shutdown
// ---------------------------------------------------------------------------------------------

/** Boots DB, catalog, upstream manager, catalog push and the status provider. */
export async function bootGateway(): Promise<void> {
  ensureDataDir();
  // Run migrations + build the catalog snapshot before accepting traffic.
  getDb();
  getCatalogSnapshot();

  await startUpstreams();

  // /api/v1/status reads live sessions through this provider (lib/api/status-hooks.ts).
  registerSessionProvider(sessionSummaries);
  startCatalogPush();
}

/** Ordered graceful shutdown (SIGTERM/SIGINT). */
export async function shutdown(
  server: ReturnType<typeof createServer>,
  signal: string,
): Promise<void> {
  logger.info({ signal }, "shutting down");
  stopCatalogPush();
  try {
    await flushPushNow();
  } catch {
    /* best effort */
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    // Do not wait forever on keep-alive clients.
    setTimeout(resolve, 5000).unref();
  });
  await closeAllSessions("shutdown");
  try {
    if (hasUpstreamManager()) await getUpstreamManager().shutdown();
  } catch (error) {
    logger.warn({ err: String(error) }, "upstream manager shutdown failed");
  }
  try {
    closeDb();
  } catch {
    /* already closed */
  }
  logger.info("shutdown complete");
}

/** Builds the HTTP server (separated from main so tests can mount it on an ephemeral port). */
export function createAppServer(nextHandler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const server = createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";

    if (pathname === "/healthz") {
      healthzHandler(req, res);
      return;
    }

    if (pathname === MCP_PATH) {
      void mcpHandler(req, res).catch((error: unknown) => {
        logger.error({ err: String(error) }, "/mcp request failed");
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: "internal_error", message: "Erreur interne de la passerelle MCP." }));
        } else if (!res.writableEnded) {
          res.end();
        }
      });
      return;
    }

    void nextHandler(req, res).catch((error: unknown) => {
      logger.error({ err: String(error) }, "Next.js request failed");
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Internal Server Error");
      }
    });
  });

  server.on("connection", (socket) => {
    // GET /mcp is a long-lived SSE stream: never let a socket timeout kill it (§11.4).
    socket.setTimeout(0);
    socket.setNoDelay(true);
  });

  return server;
}

/** Full boot: gateway state, Next handler, HTTP server, signal handlers. */
export async function main(): Promise<void> {
  await bootGateway();
  const server = createAppServer(await getNextHandler());

  await new Promise<void>((resolve) => {
    server.listen(config.port, () => {
      logger.info({ port: config.port, mode: dev ? "development" : "production" }, "Switchboard listening");
      resolve();
    });
  });

  let shuttingDown = false;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdown(server, signal).then(() => process.exit(0));
  };
  process.on("SIGTERM", () => handleSignal("SIGTERM"));
  process.on("SIGINT", () => handleSignal("SIGINT"));
}

// Only boot when executed directly (tsx server.ts / node dist/server.js), never on import.
const entry = process.argv[1] ?? "";
const isDirectRun = /(^|[\\/])server\.[cm]?[jt]s$/.test(entry);

if (isDirectRun) {
  void main().catch((error: unknown) => {
    logger.error({ err: error instanceof Error ? error.stack : String(error) }, "fatal: server failed to start");
    process.exit(1);
  });
}

export { buildHealthPayload, MCP_PATH } from "./lib/gateway/http";
