/**
 * Discoverability regression tests.
 *
 * Reported by a real agent on first use of the gateway with a key that had 80 tools behind two
 * upstreams: it saw only the discovery meta-tools, `search_tools` demanded a non-empty query, so
 * there was no "list everything" call. It burned ~50 keyword guesses to learn which upstreams were
 * reachable, and could not tell "no match" from "no access".
 *
 * These tests pin the fixes:
 *   1. search_tools({}) / query="*" lists every authorised tool.
 *   2. list_servers() returns the upstream inventory with tool counts.
 *   3. initialize's instructions contain the inventory and the enumeration hint.
 *   4. a failed search names the reachable servers and flags inaccessible ones.
 *   5. describe_tool works for the gateway's own meta-tools.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

let dir: string;
let dbmod: typeof import("../lib/db");

const TOTO_TOOLS = ["A", "B", "C"];
const JIRA_TOOLS = ["create_issue", "search_issues"];

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-discoverability-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 31).toString("base64");
  process.env.SWITCHBOARD_SECRET = "test-secret-that-is-long-enough-32";
  vi.resetModules();
  dbmod = await import("../lib/db");
});

afterEach(() => {
  dbmod?.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

async function seedUpstream(id: string, slug: string, tools: string[]): Promise<void> {
  const { upstreams, upstreamItems } = await import("../lib/db/schema");
  const now = Date.now();
  dbmod.getDb()
    .insert(upstreams)
    .values({
      id, slug, name: slug.toUpperCase(), description: slug + " server",
      transport: "http", url: "http://localhost:1/mcp", authType: "none",
      enabled: true, startMode: "always", status: "ready", createdAt: now, updatedAt: now,
    })
    .run();
  for (const name of tools) {
    dbmod.getDb()
      .insert(upstreamItems)
      .values({
        upstreamId: id, kind: "tool", name,
        definition: { name, description: name + " on " + slug, inputSchema: { type: "object", properties: {} } },
        fetchedAt: now,
      })
      .run();
  }
  const { invalidateCatalog, getCatalog } = await import("../lib/catalog/catalog");
  invalidateCatalog("seed");
  getCatalog().rebuild();
}

/** Minimal fake upstream manager: enough for listing/description, never used for calls here. */
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
    async callTool(_u: string, name: string) { return { content: [{ type: "text" as const, text: "ok:" + name }] }; },
    async getPrompt() { return { messages: [] }; }, async readResource(_u: string, uri: string) { return { contents: [{ uri, text: "x" }] }; },
    async subscribeResource() {}, async unsubscribeResource() {},
    async startOAuth() { return { authorizationUrl: "http://x" }; }, async completeOAuth() {},
    async testConfig() { return { ok: true }; },
  } as never);
}

async function openClient(keyId: string, exposureMode: "direct" | "discovery"): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const { createGatewayServer } = await import("../lib/gateway/server");
  const { createSessionState, registerSession, closeSession } = await import("../lib/gateway/sessions");
  const state = createSessionState({
    sessionId: "sess-" + Math.random().toString(36).slice(2, 8),
    keyId, keyName: keyId, exposureMode, ip: "127.0.0.1",
  });
  const server = createGatewayServer(state);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "discoverability-test", version: "1.0.0" }, { capabilities: {} });
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

async function seedKeyWithAccess(name: string, upstreamIds: string[], exposureMode: "direct" | "discovery") {
  const { createKey } = await import("../lib/auth/keys");
  const { upsertGrant } = await import("../lib/auth/grants");
  const key = createKey({ name, exposureMode });
  for (const upstreamId of upstreamIds) {
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId, toolMode: "all", tools: [] });
  }
  return key;
}

function textOf(result: unknown): string {
  const content = ((result as { content?: unknown }).content ?? []) as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? "").join("\n");
}

describe("point 1: search_tools can enumerate everything", () => {
  it("lists all authorised tools with no query", async () => {
    await seedUpstream("u1", "toto", TOTO_TOOLS);
    await seedUpstream("u2", "jira", JIRA_TOOLS);
    await installFakeManager();
    const key = await seedKeyWithAccess("hermes", ["u1", "u2"], "discovery");

    const conn = await openClient(key.id, "discovery");
    try {
      const result = await conn.client.callTool({ name: "search_tools", arguments: {} });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      for (const name of ["toto__A", "toto__B", "toto__C", "jira__create_issue", "jira__search_issues"]) {
        expect(text).toContain(name);
      }
      const structured = result.structuredContent as { total?: number };
      expect(structured?.total).toBe(5);
    } finally {
      await conn.close();
    }
  });

  it('treats query="" and query="*" as list-everything', async () => {
    await seedUpstream("u1", "toto", TOTO_TOOLS);
    await installFakeManager();
    const key = await seedKeyWithAccess("hermes-empty", ["u1"], "discovery");
    const conn = await openClient(key.id, "discovery");
    try {
      for (const query of ["", "   ", "*", "all"]) {
        const result = await conn.client.callTool({ name: "search_tools", arguments: { query } });
        expect(result.isError).toBeFalsy();
        expect(textOf(result)).toContain("toto__A");
      }
    } finally {
      await conn.close();
    }
  });

  it("honours limit and reports the total", async () => {
    await seedUpstream("u1", "toto", TOTO_TOOLS);
    await installFakeManager();
    const key = await seedKeyWithAccess("hermes-limit", ["u1"], "discovery");
    const conn = await openClient(key.id, "discovery");
    try {
      const result = await conn.client.callTool({ name: "search_tools", arguments: { limit: 2 } });
      const structured = result.structuredContent as { total?: number; shown?: number };
      expect(structured.total).toBe(3);
      expect(structured.shown).toBe(2);
    } finally {
      await conn.close();
    }
  });
});

describe("point 2: list_servers exposes the inventory", () => {
  it("returns every accessible server with its tool count", async () => {
    await seedUpstream("u1", "toto", TOTO_TOOLS);
    await seedUpstream("u2", "jira", JIRA_TOOLS);
    await installFakeManager();
    const key = await seedKeyWithAccess("hermes-servers", ["u1"], "discovery"); // only toto granted

    const conn = await openClient(key.id, "discovery");
    try {
      const result = await conn.client.callTool({ name: "list_servers", arguments: {} });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("toto");
      expect(text).toContain("3 outil");
      // jira exists on the gateway but must not be named as accessible
      expect(text).toMatch(/1 autre\(s\) serveur|1 autre serveur/);
      const structured = result.structuredContent as { servers?: Array<{ slug: string }>; otherServers?: number };
      expect(structured.servers?.map((s) => s.slug)).toEqual(["toto"]);
      expect(structured.otherServers).toBe(1);
    } finally {
      await conn.close();
    }
  });

  it("is listed in discovery mode and says how to enumerate", async () => {
    await seedUpstream("u1", "toto", TOTO_TOOLS);
    await installFakeManager();
    const key = await seedKeyWithAccess("hermes-list", ["u1"], "discovery");
    const conn = await openClient(key.id, "discovery");
    try {
      const tools = await conn.client.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("list_servers");
      const desc = tools.tools.find((t) => t.name === "list_servers")?.description ?? "";
      expect(desc.toLowerCase()).toContain("nombre d'outils");
    } finally {
      await conn.close();
    }
  });

  it("explains the empty case without inventing access", async () => {
    await seedUpstream("u1", "toto", TOTO_TOOLS);
    await installFakeManager();
    const key = await seedKeyWithAccess("no-access", [], "discovery");
    const conn = await openClient(key.id, "discovery");
    try {
      const result = await conn.client.callTool({ name: "list_servers", arguments: {} });
      const text = textOf(result);
      expect(text).toContain("Aucun serveur MCP");
      expect(text).toContain("report_feedback");
      expect(text).not.toContain("toto__");
    } finally {
      await conn.close();
    }
  });
});

describe("point 3: instructions announce the surface", () => {
  it("lists the servers and the enumeration call at initialize", async () => {
    await seedUpstream("u1", "toto", TOTO_TOOLS);
    await seedUpstream("u2", "jira", JIRA_TOOLS);
    await installFakeManager();
    const key = await seedKeyWithAccess("hermes-instr", ["u1", "u2"], "discovery");

    const conn = await openClient(key.id, "discovery");
    try {
      const instructions = conn.client.getInstructions() ?? "";
      expect(instructions).toContain("toto");
      expect(instructions).toContain("jira");
      expect(instructions).toContain("5 outils");
      expect(instructions).toContain("list_servers");
      expect(instructions).toContain("search_tools({})");
      // an example tool name so the agent can start immediately
      expect(instructions).toMatch(/toto__[ABC]|jira__/);
    } finally {
      await conn.close();
    }
  });
});

describe("point 4: a failed search distinguishes no-match from no-access", () => {
  it("names the reachable servers and flags the ones it cannot see", async () => {
    await seedUpstream("u1", "toto", TOTO_TOOLS);
    await seedUpstream("u2", "github", ["create_issue"]); // not granted
    await installFakeManager();
    const key = await seedKeyWithAccess("hermes-miss", ["u1"], "discovery");

    const conn = await openClient(key.id, "discovery");
    try {
      const result = await conn.client.callTool({ name: "search_tools", arguments: { query: "github" } });
      expect(result.isError).toBeFalsy();
      const text = textOf(result);
      expect(text).toContain("Aucun outil autorisé ne correspond");
      expect(text).toContain("toto");        // what IS reachable
      expect(text).not.toContain("github__"); // never leak the hidden tool name
      expect(text).toMatch(/ne sont PAS accessibles|report_feedback/);
      const structured = result.structuredContent as {
        matchedNothing?: boolean;
        accessibleServers?: Array<{ slug: string }>;
        inaccessibleServers?: number;
      };
      expect(structured.matchedNothing).toBe(true);
      expect(structured.accessibleServers?.[0]?.slug).toBe("toto");
      expect(structured.inaccessibleServers).toBe(1);
    } finally {
      await conn.close();
    }
  });
});

describe("point 5: describe_tool works on the gateway's own meta-tools", () => {
  it("describes report_feedback and the discovery tools", async () => {
    await seedUpstream("u1", "toto", TOTO_TOOLS);
    await installFakeManager();
    const key = await seedKeyWithAccess("hermes-describe", ["u1"], "discovery");

    const conn = await openClient(key.id, "discovery");
    try {
      for (const name of ["report_feedback", "search_tools", "list_servers", "describe_tool", "call_tool"]) {
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

  it("still hides an unauthorised upstream tool and hints at the reachable servers", async () => {
    await seedUpstream("u1", "toto", TOTO_TOOLS);
    await installFakeManager();
    const key = await seedKeyWithAccess("hermes-hidden", ["u1"], "discovery");
    const conn = await openClient(key.id, "discovery");
    try {
      const result = await conn.client.callTool({ name: "describe_tool", arguments: { name: "toto__ZZZ" } });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(text).toContain("Outil inconnu");
      expect(text).toContain("toto"); // reachable servers are named
      expect(text).toContain("search_tools");
    } finally {
      await conn.close();
    }
  });
});
