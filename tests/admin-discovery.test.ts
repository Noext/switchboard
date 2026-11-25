/**
 * Regression tests: the admin management tools must be discoverable exactly like any other
 * callable tool.
 *
 * Reported by a real agent on an admin key. `upstream_create` / `upstream_list` / `upstream_get` /
 * `upstream_update` executed fine when called directly, but:
 *
 *   1. describe_tool({name: "upstream_create"}) answered "Outil inconnu";
 *   2. call_tool({name: "upstream_create"}) answered "Tool upstream_create not found";
 *   3. search_tools({query: "upstream"}) answered "Aucun outil autorisé ne correspond";
 *   4. search_tools({}) did not list them either.
 *
 * The agent concluded the tools did not exist and went looking for a REST API. Discovery
 * contradicted the callable surface, which is the failure these tests exist to prevent: whatever
 * /mcp executes must be discoverable through the meta-tools.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

let dir: string;
let dbmod: typeof import("../lib/db");

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-admin-discovery-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 41).toString("base64");
  process.env.SWITCHBOARD_SECRET = "test-secret-that-is-long-enough-32";
  vi.resetModules();
  dbmod = await import("../lib/db");
  dbmod.getDb();
});

afterEach(() => {
  dbmod?.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

async function installFakeManager(): Promise<void> {
  const { setUpstreamManager } = await import("../lib/upstreams/types");
  setUpstreamManager({
    async startAll() {}, async shutdown() {}, async ensureConnected() {}, async disconnect() {},
    async restart() {}, async reload() {}, async remove() {},
    getState: (id: string) => ({
      id, slug: id, status: "ready" as const, lastError: null, serverInfo: null,
      capabilities: null, stderr: [], toolCount: 0,
    }),
    getAllStates: () => [], getStderr: () => [], listTools: async () => [], ping: async () => true,
    listPrompts: async () => [], listResources: async () => [], listResourceTemplates: async () => [],
    async callTool() { return { content: [{ type: "text" as const, text: "ok" }] }; },
    async getPrompt() { return { messages: [] }; },
    async readResource(_u: string, uri: string) { return { contents: [{ uri, text: "x" }] }; },
    async subscribeResource() {}, async unsubscribeResource() {},
    async startOAuth() { return { authorizationUrl: "http://x" }; }, async completeOAuth() {},
    async testConfig() { return { ok: true }; },
  } as never);
}

async function seedUpstream(id: string, slug: string, tools: string[]): Promise<void> {
  const { upstreams, upstreamItems } = await import("../lib/db/schema");
  const now = Date.now();
  dbmod.getDb().insert(upstreams).values({
    id, slug, name: slug.toUpperCase(), description: slug + " server",
    transport: "http", url: "http://localhost:1/mcp", authType: "none",
    enabled: true, startMode: "always", status: "ready", createdAt: now, updatedAt: now,
  }).run();
  for (const name of tools) {
    dbmod.getDb().insert(upstreamItems).values({
      upstreamId: id, kind: "tool", name,
      definition: { name, description: name + " on " + slug, inputSchema: { type: "object", properties: {} } },
      fetchedAt: now,
    }).run();
  }
  const { invalidateCatalog, getCatalog } = await import("../lib/catalog/catalog");
  invalidateCatalog("seed");
  getCatalog().rebuild();
}

async function seedAdminKeyWithAccess(name: string, upstreamIds: string[]) {
  const { createKey } = await import("../lib/auth/keys");
  const { upsertGrant } = await import("../lib/auth/grants");
  const key = createKey({ name, scope: "admin", exposureMode: "discovery" });
  for (const upstreamId of upstreamIds) {
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId, toolMode: "all", tools: [] });
  }
  return key;
}

async function openClient(keyId: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const { createGatewayServer } = await import("../lib/gateway/server");
  const { createSessionState, registerSession, closeSession } = await import("../lib/gateway/sessions");
  const state = createSessionState({
    sessionId: "sess-" + Math.random().toString(36).slice(2, 8),
    keyId, keyName: keyId, exposureMode: "discovery", ip: "127.0.0.1",
  });
  const server = createGatewayServer(state);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "admin-discovery-test", version: "1.0.0" }, { capabilities: {} });
  await server.connect(serverTransport);
  registerSession(state, server, serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await closeSession(state.sessionId, "test");
      await client.close();
      await server.close();
    },
  };
}

function textOf(result: unknown): string {
  const content = ((result as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? "").join("\n");
}

const ADMIN_NAMES = ["upstream_list", "upstream_get", "upstream_create", "upstream_update"];

describe("point 1: describe_tool knows every callable admin tool", () => {
  it("describes all four management tools for an admin key", async () => {
    await seedUpstream("u1", "toto", ["A"]);
    await installFakeManager();
    const key = await seedAdminKeyWithAccess("admin-describe", ["u1"]);
    const conn = await openClient(key.id);
    try {
      for (const name of ADMIN_NAMES) {
        const result = await conn.client.callTool({ name: "describe_tool", arguments: { name } });
        expect(result.isError).toBeFalsy();
        const payload = result.structuredContent as { name?: string; inputSchema?: unknown; kind?: string };
        expect(payload.name).toBe(name);
        expect(payload.inputSchema).toBeTruthy();
        expect(payload.kind).toBe("gateway");
      }
    } finally {
      await conn.close();
    }
  });

  it("still refuses to describe them for a non-admin key", async () => {
    await seedUpstream("u1", "toto", ["A"]);
    await installFakeManager();
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const agent = createKey({ name: "agent-describe", exposureMode: "discovery" });
    upsertGrant({ subjectType: "key", subjectId: agent.id, upstreamId: "u1", toolMode: "all", tools: [] });
    const conn = await openClient(agent.id);
    try {
      const result = await conn.client.callTool({ name: "describe_tool", arguments: { name: "upstream_create" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Outil inconnu");
    } finally {
      await conn.close();
    }
  });
});

describe("point 2: call_tool routes exactly what the direct path routes", () => {
  it("calls an admin tool through call_tool", async () => {
    await seedUpstream("u1", "toto", ["A"]);
    await installFakeManager();
    const key = await seedAdminKeyWithAccess("admin-call", ["u1"]);
    const conn = await openClient(key.id);
    try {
      const result = await conn.client.callTool({
        name: "call_tool",
        arguments: { name: "upstream_list", arguments: {} },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { count?: number };
      expect(structured.count).toBeGreaterThanOrEqual(1);
    } finally {
      await conn.close();
    }
  });

  it("creates an upstream through call_tool, like the direct path", async () => {
    await seedUpstream("u1", "toto", ["A"]);
    await installFakeManager();
    const key = await seedAdminKeyWithAccess("admin-call-create", ["u1"]);
    const conn = await openClient(key.id);
    try {
      const result = await conn.client.callTool({
        name: "call_tool",
        arguments: {
          name: "upstream_create",
          arguments: { name: "Via Call Tool", transport: "http", url: "http://127.0.0.1:9/mcp", enabled: false },
        },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { upstream?: { slug?: string } };
      expect(structured.upstream?.slug).toBe("viacalltool");
    } finally {
      await conn.close();
    }
  });

  it("keeps admin tools unreachable through call_tool for a non-admin key", async () => {
    await seedUpstream("u1", "toto", ["A"]);
    await installFakeManager();
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const agent = createKey({ name: "agent-call", exposureMode: "discovery" });
    upsertGrant({ subjectType: "key", subjectId: agent.id, upstreamId: "u1", toolMode: "all", tools: [] });
    const conn = await openClient(agent.id);
    try {
      await expect(
        conn.client.callTool({ name: "call_tool", arguments: { name: "upstream_create", arguments: {} } }),
      ).rejects.toThrow(/not found/i);
    } finally {
      await conn.close();
    }
  });
});

describe("points 3 and 4: search_tools sees the admin tools", () => {
  it("finds the management tools by keyword", async () => {
    await seedUpstream("u1", "toto", ["A"]);
    await installFakeManager();
    const key = await seedAdminKeyWithAccess("admin-search", ["u1"]);
    const conn = await openClient(key.id);
    try {
      const result = await conn.client.callTool({ name: "search_tools", arguments: { query: "upstream" } });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("upstream_create");
      expect(text).toContain("upstream_list");
    } finally {
      await conn.close();
    }
  });

  it("lists the admin tools in the no-query enumeration", async () => {
    await seedUpstream("u1", "toto", ["A"]);
    await installFakeManager();
    const key = await seedAdminKeyWithAccess("admin-enumerate", ["u1"]);
    const conn = await openClient(key.id);
    try {
      const result = await conn.client.callTool({ name: "search_tools", arguments: {} });
      const text = textOf(result);
      for (const name of ADMIN_NAMES) expect(text).toContain(name);
      expect(text).toContain("toto__A");
    } finally {
      await conn.close();
    }
  });

  it("shows the management tools as their own server in list_servers", async () => {
    await seedUpstream("u1", "toto", ["A"]);
    await installFakeManager();
    const key = await seedAdminKeyWithAccess("admin-servers", ["u1"]);
    const conn = await openClient(key.id);
    try {
      const result = await conn.client.callTool({ name: "list_servers", arguments: {} });
      const structured = result.structuredContent as { servers?: Array<{ slug: string; toolCount: number }> };
      const gateway = structured.servers?.find((s) => s.slug === "switchboard");
      expect(gateway?.toolCount).toBe(4);
      expect(structured.servers?.map((s) => s.slug)).toContain("toto");
    } finally {
      await conn.close();
    }
  });

  it("never leaks the management tools to a non-admin key", async () => {
    await seedUpstream("u1", "toto", ["A"]);
    await installFakeManager();
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const agent = createKey({ name: "agent-leak", exposureMode: "discovery" });
    upsertGrant({ subjectType: "key", subjectId: agent.id, upstreamId: "u1", toolMode: "all", tools: [] });
    const conn = await openClient(agent.id);
    try {
      const all = await conn.client.callTool({ name: "search_tools", arguments: {} });
      expect(textOf(all)).not.toContain("upstream_create");
      const keyword = await conn.client.callTool({ name: "search_tools", arguments: { query: "upstream" } });
      expect(textOf(keyword)).not.toContain("upstream_create");
      const servers = await conn.client.callTool({ name: "list_servers", arguments: {} });
      expect(textOf(servers)).not.toContain("switchboard (");
    } finally {
      await conn.close();
    }
  });
});
