/**
 * Live HTTP smoke test for the gateway endpoint (spec §6.1, §11.4, §12.2).
 *
 * Unlike tests/gateway.test.ts (which drives the MCP server over in-memory transports), this
 * mounts the real /mcp and /healthz handlers on a node:http server and talks to it with the SDK's
 * StreamableHTTPClientTransport, so session creation, the Mcp-Session-Id header, 401/403/404 and
 * the tools round-trip are exercised over the wire.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { keepRuntimeStateForFile } from "./helpers/reset";

// One HTTP server and one set of globals for the whole file.
keepRuntimeStateForFile();

let dir: string;
let http: HttpServer;
let base: string;
let dbmod: typeof import("../lib/db");
let agentSecret: string;
let adminSecret: string;
let closeAll: () => Promise<void>;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-gateway-http-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
  process.env.SWITCHBOARD_SECRET = "test-secret-that-is-long-enough-32";
  process.env.SWITCHBOARD_ADMIN_PASSWORD = "test-password";

  vi.resetModules();
  dbmod = await import("../lib/db");
  dbmod.getDb();

  // One ready upstream with a single tool, so tools/list is meaningful.
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
  const agent = createKey({ name: "http-agent" });
  upsertGrant({ subjectType: "key", subjectId: agent.id, upstreamId: "u1", toolMode: "all", tools: [] });
  const admin = createKey({ name: "http-admin", scope: "admin" });
  agentSecret = agent.secret;
  adminSecret = admin.secret;

  // Fake upstream manager: the HTTP tests care about the transport, not real connections.
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

  const { healthzHandler, mcpHandler } = await import("../lib/gateway/http");
  const sessions = await import("../lib/gateway/sessions");
  closeAll = () => sessions.closeAllSessions("test");

  http = createServer((req: IncomingMessage, res: ServerResponse) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname === "/healthz") {
      healthzHandler(req, res);
      return;
    }
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

describe("/healthz (spec §11.4)", () => {
  it("is reachable without authentication and reports upstreams", async () => {
    const response = await fetch(base + "/healthz");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as {
      status: string;
      version: string;
      uptimeSeconds: number;
      upstreams: Record<string, { status: string; tools: number }>;
    };
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptimeSeconds).toBe("number");
    expect(body.upstreams.toto?.status).toBe("ready");
    expect(body.upstreams.toto?.tools).toBe(1);
  });
});

describe("/mcp authentication (spec §6.1)", () => {
  it("401 without a key", async () => {
    const response = await fetch(base + "/mcp", { method: "POST" });
    expect(response.status).toBe(401);
  });

  it("401 for an unknown key", async () => {
    const response = await fetch(base + "/mcp", {
      method: "POST",
      headers: { authorization: "Bearer sk-sw-doesnotexistatall000000000000" },
    });
    expect(response.status).toBe(401);
  });

  /**
   * An admin key is accepted on /mcp, but the session it opens serves the admin tool surface,
   * never an upstream tool (lib/gateway/adminTools.ts). Previously this was a blanket 403.
   */
  it("accepts an admin-scope key and gives it only the admin tools", async () => {
    const client = new Client({ name: "admin-http", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer " + adminSecret } },
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toContain("upstream_create");
      expect(names).toContain("upstream_update");
      expect(names).toContain("upstream_list");
      expect(names).toContain("upstream_get");
      // The agent key's upstream tool must never leak into an admin session.
      expect(names).not.toContain("toto__A");
    } finally {
      await client.close();
    }
  });

  it("400 for a POST without a session that is not an initialize request", async () => {
    const response = await fetch(base + "/mcp", {
      method: "POST",
      headers: { authorization: "Bearer " + agentSecret, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(400);
  });

  it("404 for an unknown Mcp-Session-Id, so the client re-initializes", async () => {
    const response = await fetch(base + "/mcp", {
      method: "GET",
      headers: { authorization: "Bearer " + agentSecret, "mcp-session-id": "nope" },
    });
    expect(response.status).toBe(404);
  });
});

describe("/mcp session lifecycle (spec §6.1)", () => {
  it("initializes a stateful session, lists tools and calls one", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer " + agentSecret } },
    });
    const client = new Client({ name: "http-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    try {
      expect(transport.sessionId).toBeTruthy();

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual(["report_feedback", "toto__A"]);

      const result = await client.callTool({ name: "toto__A", arguments: {} });
      expect(JSON.stringify(result.content)).toContain("ok:A");

      // The session is registered and visible to the status endpoint provider.
      const { listSessions } = await import("../lib/gateway/sessions");
      expect(listSessions().some((session) => session.sessionId === transport.sessionId)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("DELETE closes the session", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
      requestInit: { headers: { authorization: "Bearer " + agentSecret } },
    });
    const client = new Client({ name: "http-delete", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const sessionId = transport.sessionId;
    expect(sessionId).toBeTruthy();

    const { getSession } = await import("../lib/gateway/sessions");
    expect(getSession(sessionId!)).toBeTruthy();

    const response = await fetch(base + "/mcp", {
      method: "DELETE",
      headers: { authorization: "Bearer " + agentSecret, "mcp-session-id": sessionId! },
    });
    expect(response.status).toBe(200);
    expect(getSession(sessionId!)).toBeNull();
  });
});
