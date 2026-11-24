/**
 * The relay must not be stricter than the upstreams behind it.
 *
 * Incident: an agent pushed a 15 MB git bundle through switchboard to Harbor.
 * The gateway answered `Payload Too Large: Request body must not exceed 4194304
 * bytes` — the SDK's own default, applied because the transport was constructed
 * without `maxRequestBodySize`. Harbor itself accepts 64 MiB bundles, so the
 * narrowest limit in the chain was a layer the caller never chose. The agent's
 * workaround was to serve the bundle over HTTP from the host into the sandbox,
 * which is strictly worse: an extra moving part, an open port, and it bypasses
 * the audit trail of the MCP call.
 *
 * These tests drive the real /mcp handler over a real socket with real large
 * bodies: a constant comparison would pass even with the option misspelled.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { keepRuntimeStateForFile } from "./helpers/reset";

keepRuntimeStateForFile();

let dir: string;
let http: HttpServer;
let base: string;
let secret: string;
let dbmod: typeof import("../lib/db");
let closeAll: () => Promise<void>;
let limitBytes: number;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-body-limit-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 13).toString("base64");
  process.env.SWITCHBOARD_SECRET = "test-secret-that-is-long-enough-32";
  process.env.SWITCHBOARD_ADMIN_PASSWORD = "test-password";

  vi.resetModules();
  dbmod = await import("../lib/db");
  dbmod.getDb();

  const { upstreams, upstreamItems } = await import("../lib/db/schema");
  const now = Date.now();
  dbmod
    .getDb()
    .insert(upstreams)
    .values({
      id: "u1",
      slug: "toto",
      name: "Toto",
      description: "Serveur toto",
      transport: "http",
      url: "http://localhost:1/mcp",
      authType: "none",
      enabled: true,
      startMode: "always",
      status: "ready",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  dbmod
    .getDb()
    .insert(upstreamItems)
    .values({
      upstreamId: "u1",
      kind: "tool",
      name: "A",
      definition: { name: "A", description: "Outil A", inputSchema: { type: "object", properties: {} } },
      fetchedAt: now,
    })
    .run();

  const { createKey } = await import("../lib/auth/keys");
  const { upsertGrant } = await import("../lib/auth/grants");
  const agent = createKey({ name: "body-limit-agent" });
  upsertGrant({ subjectType: "key", subjectId: agent.id, upstreamId: "u1", toolMode: "all", tools: [] });
  secret = agent.secret;

  const { setUpstreamManager } = await import("../lib/upstreams/types");
  const fake = {
    async startAll() {},
    async shutdown() {},
    async ensureConnected() {},
    async disconnect() {},
    async restart() {},
    async reload() {},
    async remove() {},
    getState: () => ({
      id: "u1",
      slug: "toto",
      status: "ready" as const,
      lastError: null,
      serverInfo: null,
      capabilities: null,
      stderr: [],
      toolCount: 1,
    }),
    getAllStates: () => [],
    getStderr: () => [],
    async listTools() {
      return [];
    },
    async callTool(_upstreamId: string, name: string) {
      return { content: [{ type: "text" as const, text: "ok:" + name }] };
    },
    async ping() {
      return true;
    },
    async listPrompts() {
      return [];
    },
    async getPrompt() {
      return { messages: [] };
    },
    async listResources() {
      return [];
    },
    async listResourceTemplates() {
      return [];
    },
    async readResource(_upstreamId: string, uri: string) {
      return { contents: [{ uri, text: "x" }] };
    },
    async subscribeResource() {},
    async unsubscribeResource() {},
    async startOAuth() {
      return { authorizationUrl: "http://example.invalid" };
    },
    async completeOAuth() {},
    async testConfig() {
      return { ok: true };
    },
  };
  setUpstreamManager(fake as unknown as import("../lib/upstreams/types").UpstreamManager);

  const { mcpHandler } = await import("../lib/gateway/http");
  const sessions = await import("../lib/gateway/sessions");
  const { config } = await import("../lib/config");
  limitBytes = config.defaults.maxRequestBodyBytes;
  closeAll = () => sessions.closeAllSessions("test");

  http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname === "/mcp") {
      void mcpHandler(req, res);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("could not bind an ephemeral port");
  base = "http://127.0.0.1:" + address.port;
});

afterAll(async () => {
  await closeAll?.();
  await new Promise<void>((resolve) => http?.close(() => resolve()));
  dbmod?.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

/** Open a real MCP session and return its id. */
async function openSession(): Promise<string> {
  const response = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer " + secret,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "body-limit-test", version: "1.0.0" },
      },
    }),
  });
  await response.text();
  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("no session id: HTTP " + response.status);
  return sessionId;
}

/** POST a tools/call carrying `padBytes` of padding; returns the HTTP status. */
async function postPaddedCall(sessionId: string, padBytes: number): Promise<number> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "search_tools", arguments: { pad: "A".repeat(padBytes) } },
  });
  const response = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      authorization: "Bearer " + secret,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body,
  });
  await response.text();
  return response.status;
}

describe("MCP request body limit", () => {
  it("advertises a bound above the largest upstream payload", () => {
    // Harbor accepts 64 MiB bundles; a 15 MB bundle is ~20 MB of base64.
    // The relay must not be the narrowest link in that chain.
    expect(limitBytes).toBeGreaterThan(64 * 1024 * 1024);
  });

  it("accepts a body above the SDK default of 4 MiB", async () => {
    const sessionId = await openSession();
    // 15 MiB is the size that started the incident: refused with 413 before.
    const status = await postPaddedCall(sessionId, 15 * 1024 * 1024);
    expect(status).toBe(200);
  });

  it("still refuses a body above its own bound, so the limit is real", async () => {
    // A larger bound must not become an unbounded read.
    const sessionId = await openSession();
    const status = await postPaddedCall(sessionId, limitBytes + 1024 * 1024);
    expect(status).toBe(413);
  });
});
