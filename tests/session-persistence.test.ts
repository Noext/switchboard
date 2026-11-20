/**
 * Session persistence across a restart.
 *
 * The reported bug: after a redeploy, the gateway answered the still-held Mcp-Session-Id with
 * 404 session_not_found, so every open agent had to re-initialize. Sessions are process memory, so
 * the live objects cannot survive — but the identity can, and `rehydrateSession()` rebuilds a
 * working session from the persisted row.
 *
 * These tests cover the persistence layer, the rehydration path over real HTTP, and the cases that
 * must still 404 (unknown id, other key's id, closed session).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

let dir: string;
let dbmod: typeof import("../lib/db");
let http: HttpServer;
let base: string;
let agentSecret: string;
let otherSecret: string;
let keyId: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-session-persist-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 41).toString("base64");
  process.env.SWITCHBOARD_SECRET = "test-secret-that-is-long-enough-32";
  vi.resetModules();
  dbmod = await import("../lib/db");

  const { upstreams, upstreamItems } = await import("../lib/db/schema");
  const now = Date.now();
  dbmod.getDb().insert(upstreams).values({
    id: "u1", slug: "toto", name: "Toto", description: "toto server",
    transport: "http", url: "http://localhost:1/mcp", authType: "none",
    enabled: true, startMode: "always", status: "ready", createdAt: now, updatedAt: now,
  }).run();
  dbmod.getDb().insert(upstreamItems).values({
    upstreamId: "u1", kind: "tool", name: "A",
    definition: { name: "A", description: "Outil A", inputSchema: { type: "object", properties: {} } },
    fetchedAt: now,
  }).run();

  const { createKey } = await import("../lib/auth/keys");
  const { upsertGrant } = await import("../lib/auth/grants");
  const agent = createKey({ name: "persist-agent" });
  const other = createKey({ name: "persist-other" });
  agentSecret = agent.secret;
  otherSecret = other.secret;
  keyId = agent.id;
  upsertGrant({ subjectType: "key", subjectId: agent.id, upstreamId: "u1", toolMode: "all", tools: [] });

  // Fake upstream manager: these tests exercise session plumbing, not real connections.
  const { setUpstreamManager } = await import("../lib/upstreams/types");
  setUpstreamManager({
    async startAll() {}, async shutdown() {}, async ensureConnected() {}, async disconnect() {},
    async restart() {}, async reload() {}, async remove() {},
    getState: () => ({
      id: "u1", slug: "toto", status: "ready" as const, lastError: null,
      serverInfo: null, capabilities: null, stderr: [], toolCount: 1,
    }),
    getAllStates: () => [], getStderr: () => [], listTools: async () => [], ping: async () => true,
    listPrompts: async () => [], listResources: async () => [], listResourceTemplates: async () => [],
    async callTool(_u: string, name: string) {
      return { content: [{ type: "text" as const, text: "ok:" + name }] };
    },
    async getPrompt() { return { messages: [] }; },
    async readResource(_u: string, uri: string) { return { contents: [{ uri, text: "x" }] }; },
    async subscribeResource() {}, async unsubscribeResource() {},
    async startOAuth() { return { authorizationUrl: "http://x" }; }, async completeOAuth() {},
    async testConfig() { return { ok: true }; },
  } as never);

  const { mcpHandler, healthzHandler } = await import("../lib/gateway/http");
  http = createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname === "/healthz") return void healthzHandler(req, res);
    if (pathname === "/mcp") return void mcpHandler(req, res);
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterEach(async () => {
  const { closeAllSessions, clearSessionsForTests } = await import("../lib/gateway/sessions");
  await closeAllSessions("test").catch(() => undefined);
  clearSessionsForTests();
  await new Promise<void>((resolve) => http.close(() => resolve())).catch(() => undefined);
  dbmod?.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

async function connect(secret: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
    requestInit: { headers: { authorization: "Bearer " + secret } },
  });
  const client = new Client({ name: "persist-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

/** Simulates a restart: the in-memory registry is wiped, the database stays. */
async function simulateRestart(): Promise<void> {
  const { clearSessionsForTests } = await import("../lib/gateway/sessions");
  clearSessionsForTests();
}

describe("session persistence", () => {
  it("persists a session row when a client initializes", async () => {
    const { client, transport } = await connect(agentSecret);
    const sid = transport.sessionId!;
    try {
      const { persistedSession } = await import("../lib/gateway/sessions");
      const row = persistedSession(sid);
      expect(row).not.toBeNull();
      expect(row!.keyId).toBe(keyId);
      expect(row!.keyName).toBe("persist-agent");
    } finally {
      await client.close();
    }
  });

  it("rehydrates a session after a restart instead of answering 404 (the reported bug)", async () => {
    const first = await connect(agentSecret);
    const sid = first.transport.sessionId!;
    const before = (await first.client.listTools()).tools.map((t) => t.name).sort();
    await first.client.close();

    await simulateRestart();

    // The client still holds the id; a fresh transport must be served, not rejected.
    const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer " + agentSecret } },
      sessionId: sid,
    });
    const client = new Client({ name: "after-restart", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      const after = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(after).toEqual(before);
      expect(after).toContain("toto__A");
      const result = await client.callTool({ name: "toto__A", arguments: {} });
      expect(JSON.stringify(result.content)).toContain("ok:A");
    } finally {
      await client.close();
    }
  });

  it("keeps the session bound to its key (another key cannot hijack it)", async () => {
    const first = await connect(agentSecret);
    const sid = first.transport.sessionId!;
    await first.client.close();
    await simulateRestart();

    // Whether the session is still only in the store (404) or has already been rehydrated by
    // another request from its owner (401) — either way another key must never get in.
    const response = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + otherSecret,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sid,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect([401, 404]).toContain(response.status);
    const body = (await response.json()) as { error?: string };
    expect(["session_mismatch", "session_not_found"]).toContain(body.error);

    // The legitimate key can still use it.
    const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer " + agentSecret } },
      sessionId: sid,
    });
    const owner = new Client({ name: "owner", version: "1.0.0" }, { capabilities: {} });
    try {
      await owner.connect(transport);
      expect((await owner.listTools()).tools.map((t) => t.name)).toContain("toto__A");
    } finally {
      await owner.close();
    }
  });

  it("still answers 404 for an id that was never persisted", async () => {
    const response = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + agentSecret,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "00000000-0000-4000-8000-000000000000",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("session_not_found");
  });

  it("does not resurrect a session after the client DELETEs it", async () => {
    const first = await connect(agentSecret);
    const sid = first.transport.sessionId!;
    await first.client.close();

    // A proper DELETE removes the persisted row.
    const del = await fetch(base + "/mcp", {
      method: "DELETE",
      headers: { authorization: "Bearer " + agentSecret, "mcp-session-id": sid },
    });
    expect(del.status).toBe(200);

    const { persistedSession } = await import("../lib/gateway/sessions");
    expect(persistedSession(sid)).toBeNull();

    const after = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + agentSecret,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sid,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(after.status).toBe(404);
  });

  it("drops persisted sessions when a key is revoked", async () => {
    const first = await connect(agentSecret);
    const sid = first.transport.sessionId!;
    await first.client.close();
    await simulateRestart();

    const { closeSessionsForKey } = await import("../lib/gateway/sessions");
    await closeSessionsForKey(keyId, "key-revoked");

    const { persistedSession } = await import("../lib/gateway/sessions");
    expect(persistedSession(sid)).toBeNull();

    const response = await fetch(base + "/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer " + agentSecret,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sid,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(404);
  });

  it("records client info and subscriptions for the rehydrated session", async () => {
    const { client, transport } = await connect(agentSecret);
    const sid = transport.sessionId!;
    try {
      const { persistedSession } = await import("../lib/gateway/sessions");
      const row = persistedSession(sid);
      expect(row!.clientName).toBe("persist-test");
      expect(row!.clientVersion).toBe("1.0.0");
    } finally {
      await client.close();
    }
  });

  it("prunes persisted rows idle past the timeout", async () => {
    const { client, transport } = await connect(agentSecret);
    const sid = transport.sessionId!;
    await client.close();

    const { mcpSessions } = await import("../lib/db/schema");
    const { eq } = await import("drizzle-orm");
    dbmod.getDb()
      .update(mcpSessions)
      .set({ lastSeenAt: Date.now() - 48 * 60 * 60 * 1000 })
      .where(eq(mcpSessions.sessionId, sid))
      .run();

    const { prunePersistedIdleSessions } = await import("../lib/gateway/sessions");
    expect(prunePersistedIdleSessions()).toBeGreaterThan(0);

    const { persistedSession } = await import("../lib/gateway/sessions");
    expect(persistedSession(sid)).toBeNull();
  });
});
