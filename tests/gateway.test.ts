/**
 * Gateway integration tests (spec §6.2, §6.3, §6.5, §7.3, §12.2).
 *
 * The real per-session MCP server is driven through the SDK's linked in-memory transports against
 * a fake UpstreamManager, so listing, routing, denial logging and discovery mode are exercised
 * end to end over the actual JSON-RPC surface.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { CallOptions, CallToolOutcome, UpstreamManager } from "../lib/upstreams/types";

let dir: string;
let dbmod: typeof import("../lib/db");

interface FakeCall {
  upstreamId: string;
  toolName: string;
  args: Record<string, unknown>;
  options?: CallOptions;
}

/** Records calls and answers deterministically; every upstream reports "ready". */
class FakeManager {
  readonly calls: FakeCall[] = [];
  readonly promptCalls: Array<{ upstreamId: string; name: string; args?: Record<string, string> }> = [];
  readonly resourceCalls: Array<{ upstreamId: string; uri: string }> = [];
  readonly subscriptions: Array<{ upstreamId: string; uri: string; subscribed: boolean }> = [];
  readonly connected: string[] = [];
  failing = new Map<string, string>();

  async startAll(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async ensureConnected(upstreamId: string): Promise<void> {
    this.connected.push(upstreamId);
  }
  async disconnect(): Promise<void> {}
  async restart(): Promise<void> {}
  async reload(): Promise<void> {}
  async remove(): Promise<void> {}

  getState(upstreamId: string) {
    return {
      id: upstreamId,
      slug: upstreamId,
      status: "ready" as const,
      lastError: null,
      serverInfo: { name: "fake", version: "1.0.0" },
      capabilities: {} as Record<string, unknown>,
      stderr: [] as string[],
      toolCount: 0,
    };
  }

  getAllStates() {
    return [];
  }

  getStderr(): string[] {
    return [];
  }

  async listTools() {
    return [];
  }

  async callTool(
    upstreamId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<CallToolOutcome> {
    this.calls.push({ upstreamId, toolName, args, options });
    const failure = this.failing.get(toolName);
    if (failure) throw new Error(failure);
    options?.onProgress?.({ progress: 1, total: 2, message: "moitié" });
    return { content: [{ type: "text", text: "ok:" + upstreamId + ":" + toolName + ":" + JSON.stringify(args) }] };
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async listPrompts() {
    return [];
  }

  async getPrompt(upstreamId: string, name: string, args?: Record<string, string>) {
    this.promptCalls.push({ upstreamId, name, args });
    return { description: "prompt", messages: [{ role: "user", content: { type: "text", text: "hi" } }] };
  }

  async listResources() {
    return [];
  }

  async listResourceTemplates() {
    return [];
  }

  async readResource(upstreamId: string, uri: string) {
    this.resourceCalls.push({ upstreamId, uri });
    return { contents: [{ uri, mimeType: "text/plain", text: "contenu" }] };
  }

  async subscribeResource(upstreamId: string, uri: string): Promise<void> {
    this.subscriptions.push({ upstreamId, uri, subscribed: true });
  }

  async unsubscribeResource(upstreamId: string, uri: string): Promise<void> {
    this.subscriptions.push({ upstreamId, uri, subscribed: false });
  }

  async startOAuth() {
    return { authorizationUrl: "http://example.invalid/oauth" };
  }

  async completeOAuth(): Promise<void> {}

  async testConfig() {
    return { ok: true };
  }
}

function installManager(manager: FakeManager): void {
  // The fake implements every method the gateway uses; the cast is confined to this test file.
  void import("../lib/upstreams/types").then(({ setUpstreamManager }) => {
    setUpstreamManager(manager as unknown as UpstreamManager);
  });
}

async function seedUpstream(
  id: string,
  slug: string,
  tools: string[],
  extra: { prompts?: string[]; resources?: string[] } = {},
): Promise<void> {
  const { upstreams, upstreamItems } = await import("../lib/db/schema");
  const now = Date.now();
  dbmod.getDb()
    .insert(upstreams)
    .values({
      id,
      slug,
      name: slug.toUpperCase(),
      description: slug + " server",
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
  for (const name of tools) {
    dbmod.getDb()
      .insert(upstreamItems)
      .values({
        upstreamId: id,
        kind: "tool",
        name,
        definition: {
          name,
          description: "Outil " + name + " de " + slug,
          inputSchema: { type: "object", properties: { x: { type: "string" } } },
          annotations: { readOnlyHint: true },
        },
        fetchedAt: now,
      })
      .run();
  }
  for (const name of extra.prompts ?? []) {
    dbmod.getDb()
      .insert(upstreamItems)
      .values({ upstreamId: id, kind: "prompt", name, definition: { name, description: "Prompt " + name }, fetchedAt: now })
      .run();
  }
  for (const uri of extra.resources ?? []) {
    dbmod.getDb()
      .insert(upstreamItems)
      .values({ upstreamId: id, kind: "resource", name: uri, definition: { uri, name: uri }, fetchedAt: now })
      .run();
  }
}

interface Connected {
  client: Client;
  close: () => Promise<void>;
}

/**
 * Opens a real MCP session against a fresh gateway server for this key.
 * Several clients may be open at once (one per key), so the registry is never cleared here.
 */
async function openClient(keyId: string, exposureMode: "direct" | "discovery" = "direct"): Promise<Connected> {
  const { createGatewayServer } = await import("../lib/gateway/server");
  const { createSessionState, registerSession } = await import("../lib/gateway/sessions");
  const state = createSessionState({
    sessionId: "sess-" + Math.random().toString(36).slice(2, 8),
    keyId,
    keyName: keyId,
    exposureMode,
    ip: "127.0.0.1",
  });
  const server = createGatewayServer(state);
  const pair = InMemoryTransport.createLinkedPair();
  const clientTransport = pair[0];
  const serverTransport = pair[1];
  const client = new Client({ name: "gateway-test", version: "1.0.0" }, { capabilities: {} });
  await server.connect(serverTransport);
  registerSession(state, server, serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      const { closeSession } = await import("../lib/gateway/sessions");
      await closeSession(state.sessionId, "test");
      await client.close();
      await server.close();
    },
  };
}

async function settleManager(manager: FakeManager): Promise<void> {
  installManager(manager);
  // installManager defers one microtask via the dynamic import; wait for it.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-gateway-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");
  process.env.SWITCHBOARD_SECRET = "test-secret-that-is-long-enough-32";
  process.env.SWITCHBOARD_ADMIN_PASSWORD = "test-password";
  vi.resetModules();
  dbmod = await import("../lib/db");
});

afterEach(() => {
  try {
    dbmod?.closeDb();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("gateway tools/list", () => {
  it("filters tools by the key's effective access (spec §7.3 / §12.2)", async () => {
    await seedUpstream("u1", "toto", ["A", "B", "C", "D"]);
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const aaa = createKey({ name: "sk-aaa" });
    upsertGrant({ subjectType: "key", subjectId: aaa.id, upstreamId: "u1", toolMode: "selected", tools: ["A", "B", "C"] });
    const bbb = createKey({ name: "sk-bbb" });
    upsertGrant({ subjectType: "key", subjectId: bbb.id, upstreamId: "u1", toolMode: "selected", tools: ["B"] });

    const a = await openClient(aaa.id);
    const b = await openClient(bbb.id);
    try {
      const listA = await a.client.listTools();
      expect(listA.tools.map((tool) => tool.name).sort()).toEqual(["report_feedback", "toto__A", "toto__B", "toto__C"]);
      // inputSchema + annotations are forwarded untouched (spec §5).
      const toolA = listA.tools.find((tool) => tool.name === "toto__A");
      expect(toolA?.inputSchema.properties).toHaveProperty("x");
      expect(toolA?.annotations?.readOnlyHint).toBe(true);

      const listB = await b.client.listTools();
      expect(listB.tools.map((tool) => tool.name).sort()).toEqual(["report_feedback", "toto__B"]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("honours key_denies and globally disabled tools", async () => {
    await seedUpstream("u1", "toto", ["A", "B"]);
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant, setKeyDenies } = await import("../lib/auth/grants");
    const key = createKey({ name: "denied" });
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "all", tools: [] });
    setKeyDenies(key.id, [{ upstreamId: "u1", toolName: "A" }]);
    const { setOverride } = await import("../lib/catalog/overrides");
    setOverride("u1", "tool", "B", { enabled: false });

    const conn = await openClient(key.id);
    try {
      const tools = await conn.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["report_feedback"]);
    } finally {
      await conn.close();
    }
  });
});

describe("gateway tools/call", () => {
  it("routes an authorised call to the upstream with the original name restored", async () => {
    await seedUpstream("u1", "toto", ["A", "B"]);
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const key = createKey({ name: "caller" });
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "all", tools: [] });

    const manager = new FakeManager();
    await settleManager(manager);

    const conn = await openClient(key.id);
    try {
      const result = await conn.client.callTool({ name: "toto__A", arguments: { x: "1" } });
      expect(result.isError).toBeFalsy();
      expect(manager.calls).toHaveLength(1);
      expect(manager.calls[0]).toMatchObject({ upstreamId: "u1", toolName: "A", args: { x: "1" } });
      expect(JSON.stringify(result.content)).toContain("ok:u1:A");

      const { callLogs } = await import("../lib/db/schema");
      const rows = dbmod.getDb().select().from(callLogs).all();
      const row = rows.find((candidate) => candidate.name === "toto__A");
      expect(row?.denied).toBe(false);
      expect(row?.ok).toBe(true);
    } finally {
      await conn.close();
    }
  });

  it("rejects an unauthorised call exactly like an unknown tool and logs denied", async () => {
    await seedUpstream("u1", "toto", ["A", "B"]);
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const key = createKey({ name: "sk-bbb" });
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "selected", tools: ["B"] });

    const manager = new FakeManager();
    await settleManager(manager);

    const conn = await openClient(key.id);
    try {
      const deniedError = await conn.client.callTool({ name: "toto__A", arguments: {} }).then(
        () => null,
        (error: unknown) => error as { code: number; message: string },
      );
      const unknownError = await conn.client.callTool({ name: "toto__ZZZ", arguments: {} }).then(
        () => null,
        (error: unknown) => error as { code: number; message: string },
      );

      expect(deniedError).not.toBeNull();
      expect(unknownError).not.toBeNull();
      // Same JSON-RPC code AND same message: a caller cannot tell the two situations apart
      // (spec §6.2/§10). The SDK prefixes "MCP error <code>:" on the wire; the assertion is on
      // the identity of the two errors, not on that cosmetic prefix.
      expect(deniedError?.code).toBe(-32602);
      expect(deniedError?.code).toBe(unknownError?.code);
      // Identical wording up to the echoed name; the code is the same, so a client cannot tell
      // "not authorised" from "does not exist".
      const normalize = (message: string | undefined) =>
        (message ?? "").replace(/Tool toto__(A|ZZZ) not found/, "Tool <name> not found");
      expect(normalize(deniedError?.message)).toBe(normalize(unknownError?.message));
      expect(deniedError?.message).toContain("Tool toto__A not found");
      expect(manager.calls).toHaveLength(0);

      const { callLogs } = await import("../lib/db/schema");
      const deniedRows = dbmod
        .getDb()
        .select()
        .from(callLogs)
        .all()
        .filter((row) => row.denied);
      const denied = deniedRows.find((row) => row.name === "toto__A");
      expect(denied).toBeTruthy();
      expect(denied?.ok).toBe(false);
    } finally {
      await conn.close();
    }
  });

  it("returns an actionable isError result when the upstream fails", async () => {
    await seedUpstream("u1", "jira", ["create_issue"]);
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const key = createKey({ name: "failing" });
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "all", tools: [] });

    const manager = new FakeManager();
    manager.failing.set("create_issue", "connexion refusée");
    await settleManager(manager);

    const conn = await openClient(key.id);
    try {
      const result = await conn.client.callTool({ name: "jira__create_issue", arguments: {} });
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain("jira");
      expect(text).toContain("connexion refusée");
    } finally {
      await conn.close();
    }
  });
});

describe("discovery mode (spec §6.3)", () => {
  it("replaces the tool list by list_servers, search_tools, describe_tool, call_tool + report_feedback", async () => {
    await seedUpstream("u1", "toto", ["A", "B", "C"]);
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const key = createKey({ name: "discovery", exposureMode: "discovery" });
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "all", tools: [] });

    const conn = await openClient(key.id, "discovery");
    try {
      const tools = await conn.client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "call_tool",
        "describe_tool",
        "list_servers",
        "report_feedback",
        "search_tools",
      ]);
    } finally {
      await conn.close();
    }
  });

  it("search_tools only returns authorised tools; describe_tool hides the rest", async () => {
    await seedUpstream("u1", "toto", ["A", "B"]);
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const key = createKey({ name: "disc-selected", exposureMode: "discovery" });
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "selected", tools: ["B"] });

    const conn = await openClient(key.id, "discovery");
    try {
      const search = await conn.client.callTool({ name: "search_tools", arguments: { query: "Outil" } });
      expect(search.isError).toBeFalsy();
      const text = JSON.stringify(search.content);
      expect(text).toContain("toto__B");
      expect(text).not.toContain("toto__A");

      const described = await conn.client.callTool({ name: "describe_tool", arguments: { name: "toto__B" } });
      expect(described.isError).toBeFalsy();
      expect(JSON.stringify(described.content)).toContain("inputSchema");

      // An unauthorised tool is reported exactly like an unknown one: only the name the client
      // sent is echoed back, never the existence of the tool or its schema (spec §6.2/§10).
      const unauthorised = await conn.client.callTool({ name: "describe_tool", arguments: { name: "toto__A" } });
      const unknown = await conn.client.callTool({ name: "describe_tool", arguments: { name: "toto__NOPE" } });
      expect(unauthorised.isError).toBe(true);
      expect(unknown.isError).toBe(true);
      expect(JSON.stringify(unauthorised.content)).not.toContain("inputSchema");
      const normalize = (content: string) => content.replace(/toto__(A|NOPE)/g, "toto__<name>");
      expect(normalize(JSON.stringify(unauthorised.content))).toBe(normalize(JSON.stringify(unknown.content)));
    } finally {
      await conn.close();
    }
  });

  it("call_tool applies the same access check as tools/call", async () => {
    await seedUpstream("u1", "toto", ["A", "B"]);
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const key = createKey({ name: "disc-call", exposureMode: "discovery" });
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "selected", tools: ["B"] });
    const manager = new FakeManager();
    await settleManager(manager);

    const conn = await openClient(key.id, "discovery");
    try {
      const ok = await conn.client.callTool({
        name: "call_tool",
        arguments: { name: "toto__B", arguments: { x: "y" } },
      });
      expect(ok.isError).toBeFalsy();
      expect(manager.calls[0]).toMatchObject({ upstreamId: "u1", toolName: "B" });

      const denied = await conn.client.callTool({ name: "call_tool", arguments: { name: "toto__A", arguments: {} } }).then(
        () => null,
        (error: unknown) => error as { code: number; message: string },
      );
      expect(denied?.code).toBe(-32602);
      expect(denied?.message).toContain("Tool toto__A not found");
      expect(manager.calls).toHaveLength(1);
    } finally {
      await conn.close();
    }
  });
});

describe("report_feedback (spec §6.5)", () => {
  it("is listed for a key with no access at all, and records a report", async () => {
    await seedUpstream("u1", "toto", ["A"]);
    const { createKey } = await import("../lib/auth/keys");
    const key = createKey({ name: "no-grants" });

    const conn = await openClient(key.id);
    try {
      const tools = await conn.client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["report_feedback"]);
      expect(tools.tools[0]?.description ?? "").toContain("administrateur");

      const result = await conn.client.callTool({
        name: "report_feedback",
        arguments: {
          category: "access_needed",
          severity: "high",
          title: "Accès à toto requis",
          description: "J'ai besoin de l'outil toto__A pour terminer ma tâche.",
          tool: "toto__A",
        },
      });
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.content)).toContain("enregistré");

      const { feedback } = await import("../lib/db/schema");
      const rows = dbmod.getDb().select().from(feedback).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.keyId).toBe(key.id);
      expect(rows[0]?.category).toBe("access_needed");
      // The gateway derives upstreamSlug without revealing whether the tool exists (spec §6.5).
      expect(rows[0]?.upstreamSlug).toBe("toto");
    } finally {
      await conn.close();
    }
  });

  it("disappears when the Settings switch is off", async () => {
    await seedUpstream("u1", "toto", ["A"]);
    const { createKey } = await import("../lib/auth/keys");
    const { setSetting } = await import("../lib/settings");
    const key = createKey({ name: "no-feedback" });
    setSetting("feedbackEnabled", false);

    const conn = await openClient(key.id);
    try {
      const tools = await conn.client.listTools();
      expect(tools.tools).toHaveLength(0);
    } finally {
      await conn.close();
      setSetting("feedbackEnabled", true);
    }
  });
});

describe("instructions (spec §6.1)", () => {
  it("lists visible upstreams, their role and the report_feedback sentence", async () => {
    await seedUpstream("u1", "toto", ["A", "B"]);
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const key = createKey({ name: "instr" });
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "all", tools: [] });

    const { instructionsForKey } = await import("../lib/gateway/instructions");
    const text = instructionsForKey(key.id, false);
    expect(text).toContain("toto");
    expect(text).toContain("toto server");
    expect(text).toContain("report_feedback");
    expect(text).not.toContain("search_tools");

    const discoveryText = instructionsForKey(key.id, true);
    expect(discoveryText).toContain("search_tools");
    expect(discoveryText).toContain("describe_tool");
    expect(discoveryText).toContain("call_tool");
  });
});

describe("session registry", () => {
  it("tracks sessions per key, touches them and sweeps idle ones", async () => {
    const {
      createSessionState,
      registerSession,
      getSession,
      closeSession,
      closeSessionsForKey,
      listSessions,
      touch,
      sweepIdleSessions,
      clearSessionsForTests,
    } = await import("../lib/gateway/sessions");
    const { createGatewayServer } = await import("../lib/gateway/server");
    clearSessionsForTests();

    const make = (sessionId: string, keyId: string) => {
      const state = createSessionState({
        sessionId,
        keyId,
        keyName: keyId,
        exposureMode: "direct",
        ip: "127.0.0.1",
      });
      const server = createGatewayServer(state);
      registerSession(state, server, { close: async () => undefined });
      return state;
    };

    make("s1", "key-1");
    make("s2", "key-1");
    make("s3", "key-2");
    expect(listSessions()).toHaveLength(3);

    const before = getSession("s1")?.lastSeenAt ?? 0;
    touch("s1");
    expect(getSession("s1")?.lastSeenAt ?? 0).toBeGreaterThanOrEqual(before);

    // Make s2 look 25 h idle, then sweep: only that one is closed (spec §6.1: 24 h).
    const stale = getSession("s2");
    if (stale) stale.lastSeenAt = Date.now() - 25 * 60 * 60 * 1000;
    expect(await sweepIdleSessions()).toBe(1);
    expect(getSession("s2")).toBeNull();

    expect(await closeSessionsForKey("key-1")).toBe(1);
    expect(listSessions().map((session) => session.sessionId)).toEqual(["s3"]);
    await closeSession("s3");
    expect(listSessions()).toHaveLength(0);
  });
});

describe("catalog push (spec §5 / §7.2)", () => {
  it("notifies only the sessions whose visible tools changed", async () => {
    await seedUpstream("u1", "toto", ["A"]);
    await seedUpstream("u2", "gh", ["create_issue"]);
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const totoKey = createKey({ name: "toto-key" });
    upsertGrant({ subjectType: "key", subjectId: totoKey.id, upstreamId: "u1", toolMode: "all", tools: [] });
    const ghKey = createKey({ name: "gh-key" });
    upsertGrant({ subjectType: "key", subjectId: ghKey.id, upstreamId: "u2", toolMode: "all", tools: [] });

    const { createSessionState, registerSession, clearSessionsForTests } = await import("../lib/gateway/sessions");
    const { primeKeyView, pushKeyChanges, refreshKeyView, forgetKeyView } = await import("../lib/gateway/push");
    clearSessionsForTests();

    const counters = { toto: 0, gh: 0 };
    const fakeServer = (label: "toto" | "gh") => ({
      sendToolListChanged: async () => {
        counters[label] += 1;
      },
      sendPromptListChanged: async () => undefined,
      sendResourceListChanged: async () => undefined,
    });

    const register = (keyId: string, sessionId: string, label: "toto" | "gh") => {
      const state = createSessionState({ sessionId, keyId, keyName: keyId, exposureMode: "direct", ip: null });
      registerSession(state, fakeServer(label) as unknown as Server, { close: async () => undefined });
      primeKeyView(keyId);
    };

    register(totoKey.id, "s-toto", "toto");
    register(ghKey.id, "s-gh", "gh");
    refreshKeyView(totoKey.id);
    refreshKeyView(ghKey.id);

    // A new tool appears on toto; a "all" grant picks it up immediately (spec §7.4).
    const { upstreamItems } = await import("../lib/db/schema");
    dbmod.getDb()
      .insert(upstreamItems)
      .values({
        upstreamId: "u1",
        kind: "tool",
        name: "C",
        definition: { name: "C", description: "nouvel outil" },
        fetchedAt: Date.now(),
      })
      .run();
    const { invalidateCatalog, getCatalogSnapshot } = await import("../lib/catalog/catalog");
    invalidateCatalog("test");
    getCatalogSnapshot();

    expect(await pushKeyChanges(totoKey.id)).toContain("tools");
    expect(await pushKeyChanges(ghKey.id)).toHaveLength(0);
    expect(counters.toto).toBe(1);
    expect(counters.gh).toBe(0);

    forgetKeyView(totoKey.id);
    forgetKeyView(ghKey.id);
    clearSessionsForTests();
  });
});
describe("prompts and resources (spec §7.3)", () => {
  it("lists and gets prompts only when the grant allows prompts", async () => {
    await seedUpstream("u1", "gh", ["create_issue"], { prompts: ["review"] });
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const withPrompts = createKey({ name: "with-prompts" });
    upsertGrant({
      subjectType: "key",
      subjectId: withPrompts.id,
      upstreamId: "u1",
      toolMode: "all",
      tools: [],
      prompts: true,
    });
    const withoutPrompts = createKey({ name: "no-prompts" });
    upsertGrant({ subjectType: "key", subjectId: withoutPrompts.id, upstreamId: "u1", toolMode: "all", tools: [] });

    const manager = new FakeManager();
    await settleManager(manager);

    const allowed = await openClient(withPrompts.id);
    const deniedClient = await openClient(withoutPrompts.id);
    try {
      const list = await allowed.client.listPrompts();
      expect(list.prompts.map((prompt) => prompt.name)).toEqual(["gh__review"]);

      const got = await allowed.client.getPrompt({ name: "gh__review", arguments: { x: "1" } });
      expect(JSON.stringify(got.messages)).toContain("hi");
      expect(manager.promptCalls[0]).toMatchObject({ upstreamId: "u1", name: "review" });

      const none = await deniedClient.client.listPrompts();
      expect(none.prompts).toHaveLength(0);

      const rejected = await deniedClient.client.getPrompt({ name: "gh__review" }).then(
        () => null,
        (error: unknown) => error as { code: number; message: string },
      );
      expect(rejected?.code).toBe(-32602);
      expect(rejected?.message).toContain("Prompt gh__review not found");
    } finally {
      await allowed.close();
      await deniedClient.close();
    }
  });

  it("reads and subscribes to resources only when the grant allows resources", async () => {
    await seedUpstream("u1", "gh", ["create_issue"], { resources: ["file:///repo/README.md"] });
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const key = createKey({ name: "with-resources" });
    upsertGrant({
      subjectType: "key",
      subjectId: key.id,
      upstreamId: "u1",
      toolMode: "all",
      tools: [],
      resources: true,
    });
    const bare = createKey({ name: "no-resources" });
    upsertGrant({ subjectType: "key", subjectId: bare.id, upstreamId: "u1", toolMode: "all", tools: [] });

    const manager = new FakeManager();
    await settleManager(manager);

    const allowed = await openClient(key.id);
    const deniedClient = await openClient(bare.id);
    try {
      const list = await allowed.client.listResources();
      expect(list.resources.map((resource) => resource.uri)).toEqual(["file:///repo/README.md"]);

      const read = await allowed.client.readResource({ uri: "file:///repo/README.md" });
      expect(JSON.stringify(read.contents)).toContain("contenu");
      expect(manager.resourceCalls[0]).toMatchObject({ upstreamId: "u1", uri: "file:///repo/README.md" });

      await allowed.client.subscribeResource({ uri: "file:///repo/README.md" });
      expect(manager.subscriptions.at(-1)).toMatchObject({ subscribed: true });

      const none = await deniedClient.client.listResources();
      expect(none.resources).toHaveLength(0);

      const rejected = await deniedClient.client.readResource({ uri: "file:///repo/README.md" }).then(
        () => null,
        (error: unknown) => error as { code: number; message: string },
      );
      expect(rejected?.code).toBe(-32602);
    } finally {
      await allowed.close();
      await deniedClient.close();
    }
  });
});

describe("live changes (spec §5, §6.1, §12.2)", () => {
  it("a grant change is reflected on the next listing without reconnecting", async () => {
    await seedUpstream("u1", "toto", ["A", "B"]);
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const key = createKey({ name: "live" });
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "selected", tools: ["A"] });

    const conn = await openClient(key.id);
    try {
      expect((await conn.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "report_feedback",
        "toto__A",
      ]);
      upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "selected", tools: ["A", "B"] });
      expect((await conn.client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "report_feedback",
        "toto__A",
        "toto__B",
      ]);
    } finally {
      await conn.close();
    }
  });

  it("a revoked key is denied mid-session (access is re-read from the DB on every call)", async () => {
    await seedUpstream("u1", "toto", ["A"]);
    const { createKey, revokeKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const key = createKey({ name: "revoked-mid-session" });
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "all", tools: [] });

    const manager = new FakeManager();
    await settleManager(manager);

    const conn = await openClient(key.id);
    try {
      const before = await conn.client.callTool({ name: "toto__A", arguments: {} });
      expect(before.isError).toBeFalsy();

      revokeKey(key.id);

      expect((await conn.client.listTools()).tools).toHaveLength(0);
      const after = await conn.client.callTool({ name: "toto__A", arguments: {} }).then(
        () => null,
        (error: unknown) => error as { code: number },
      );
      expect(after?.code).toBe(-32602);
      expect(manager.calls).toHaveLength(1);

      // The gateway's own tools are unreachable too: a revoked key is good for nothing.
      const feedbackAfter = await conn
        .client.callTool({
          name: "report_feedback",
          arguments: { category: "other", title: "après révocation", description: "ne doit pas passer" },
        })
        .then(
          () => null,
          (error: unknown) => error as { code: number },
        );
      expect(feedbackAfter).not.toBeNull();
      const { feedback } = await import("../lib/db/schema");
      expect(dbmod.getDb().select().from(feedback).all()).toHaveLength(0);
    } finally {
      await conn.close();
    }
  });

  it("sends notifications/tools/list_changed to the open client", async () => {
    await seedUpstream("u1", "toto", ["A"]);
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const key = createKey({ name: "notified" });
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "all", tools: [] });

    const { refreshKeyView, pushKeyChanges } = await import("../lib/gateway/push");
    const conn = await openClient(key.id);
    try {
      let notified = 0;
      conn.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        notified += 1;
        return Promise.resolve();
      });
      refreshKeyView(key.id);

      const { upstreamItems } = await import("../lib/db/schema");
      dbmod.getDb()
        .insert(upstreamItems)
        .values({
          upstreamId: "u1",
          kind: "tool",
          name: "B",
          definition: { name: "B", description: "nouvel outil" },
          fetchedAt: Date.now(),
        })
        .run();
      const { invalidateCatalog, getCatalogSnapshot } = await import("../lib/catalog/catalog");
      invalidateCatalog("test");
      getCatalogSnapshot();

      expect(await pushKeyChanges(key.id)).toContain("tools");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(notified).toBe(1);
    } finally {
      await conn.close();
    }
  });
});
describe("per-key rate limits (spec §10)", () => {
  it("caps concurrent calls per key and releases the allowance when calls finish", async () => {
    await seedUpstream("u1", "toto", ["A"]);
    const { createKey } = await import("../lib/auth/keys");
    const { upsertGrant } = await import("../lib/auth/grants");
    const key = createKey({ name: "hammer" });
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "all", tools: [] });

    const manager = new FakeManager();
    await settleManager(manager);
    // Keep every call pending so concurrency accumulates deterministically.
    const gates: Array<() => void> = [];
    manager.callTool = async (upstreamId: string, toolName: string, args: Record<string, unknown>) => {
      manager.calls.push({ upstreamId, toolName, args });
      await new Promise<void>((resolve) => gates.push(resolve));
      return { content: [{ type: "text", text: "ok" }] };
    };

    const { callPublicTool, resetRateLimits } = await import("../lib/gateway/router");
    resetRateLimits();
    const ctx = { keyId: key.id, sessionId: "rate-session" };

    const pending: Array<Promise<unknown>> = [];
    for (let i = 0; i < 50; i++) pending.push(callPublicTool("toto__A", {}, ctx));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const refusal = await callPublicTool("toto__A", {}, ctx).then(
      () => null,
      (error: unknown) => error as { message: string; code: number },
    );
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe(-32602);
    expect(refusal?.message).toContain("simultanés");

    // The refusal is journaled so the admin can see the abuse (§6.2/§10).
    const { callLogs } = await import("../lib/db/schema");
    const rows = dbmod.getDb().select().from(callLogs).all();
    expect(rows.some((row) => row.errorCode === "rate-limited")).toBe(true);

    for (const release of gates) release();
    await Promise.allSettled(pending);

    // Allowance is given back once the calls complete: restore an immediate fake and retry.
    manager.callTool = async (upstreamId: string, toolName: string, args: Record<string, unknown>) => {
      manager.calls.push({ upstreamId, toolName, args });
      return { content: [{ type: "text", text: "ok" }] };
    };
    const after = await callPublicTool("toto__A", {}, ctx);
    expect(after.isError).toBeFalsy();
    resetRateLimits();
  });
});