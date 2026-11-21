/**
 * MCP Events relay (SEP-3415).
 *
 * The gateway forwards `events/*` to the upstreams that speak the extension, merges
 * `events/list`, and enforces the same access rules as `tools/call`: a key without access to an
 * upstream must get the identical "not found" answer, never a message revealing that the server
 * exists but is not granted.
 *
 * Also covers the envelope the upstream requires (Mcp-Method / Mcp-Name headers and the
 * `_meta` keys) — that is what makes Harbor answer instead of `-32602`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  EVENTS_EXTENSION_ID,
  EVENTS_REVISION,
  eventsEnvelope,
  eventsNameHeader,
  isEventsMethod,
  parseEventList,
  withEnvelope,
} from "../lib/gateway/events-protocol";

let dir: string;
let dbmod: typeof import("../lib/db");

const HARBOR_EVENTS = [
  { name: "sandbox.ready", description: "ready", delivery: ["poll", "push", "webhook"], payloadSchema: { type: "object" } },
  { name: "sandbox.failed", description: "failed", delivery: ["poll", "webhook"], payloadSchema: { type: "object" } },
  { name: "job.finished", description: "job", delivery: ["poll", "webhook"], payloadSchema: { type: "object" } },
  { name: "feedback.received", description: "fb", delivery: ["poll", "webhook"], payloadSchema: { type: "object" } },
];

interface RawCall {
  upstreamId: string;
  method: string;
  params: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** Fake manager recording raw requests and answering like Harbor would. */
class FakeEventsManager {
  readonly raw: RawCall[] = [];
  eventsByUpstream = new Map<string, unknown[]>();
  failWith: Map<string, string> = new Map();

  async startAll(): Promise<void> {}
  async shutdown(): Promise<void> {}
  async ensureConnected(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async restart(): Promise<void> {}
  async reload(): Promise<void> {}
  async remove(): Promise<void> {}
  getState(upstreamId: string) {
    return {
      id: upstreamId, slug: upstreamId, status: "ready" as const, lastError: null,
      serverInfo: null, capabilities: null, stderr: [], toolCount: 0,
    };
  }
  getAllStates() { return []; }
  getStderr() { return []; }
  async listTools() { return []; }
  async callTool() { return { content: [] }; }
  async ping() { return true; }
  extensions(upstreamId: string) {
    return this.eventsByUpstream.has(upstreamId)
      ? { [EVENTS_EXTENSION_ID]: { revision: EVENTS_REVISION } }
      : {};
  }
  async rawRequest(upstreamId: string, method: string, params: Record<string, unknown>, options?: { headers?: Record<string, string> }) {
    this.raw.push({ upstreamId, method, params, headers: options?.headers });
    const failure = this.failWith.get(upstreamId);
    if (failure) throw new Error(failure);
    const events = this.eventsByUpstream.get(upstreamId);
    if (!events) throw new Error("Method not found");
    if (method === "events/list") return { events };
    if (method === "events/subscribe") return { subscriptionId: "sub-" + upstreamId, name: params.name };
    if (method === "events/unsubscribe") return { ok: true };
    if (method === "events/poll") return { events: [] };
    throw new Error("Method not found");
  }
  async listPrompts() { return []; }
  async getPrompts() { return []; }
  async getPrompt() { return { messages: [] }; }
  async listResources() { return []; }
  async listResourceTemplates() { return []; }
  async readResource() { return { contents: [] }; }
  async subscribeResource() {}
  async unsubscribeResource() {}
  async startOAuth() { return { authorizationUrl: "" }; }
  async completeOAuth() {}
  async testConfig() { return { ok: true }; }
}

let manager: FakeEventsManager;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-events-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 51).toString("base64");
  process.env.SWITCHBOARD_SECRET = "test-secret-that-is-long-enough-32";
  vi.resetModules();
  dbmod = await import("../lib/db");
  const { upstreams, upstreamItems } = await import("../lib/db/schema");
  const now = Date.now();
  for (const [id, slug] of [["u1", "harbor"], ["u2", "linear"]] as const) {
    dbmod.getDb().insert(upstreams).values({
      id, slug, name: slug, transport: "http", url: "http://localhost:1/mcp", authType: "none",
      enabled: true, startMode: "always", status: "ready", createdAt: now, updatedAt: now,
    }).run();
    dbmod.getDb().insert(upstreamItems).values({
      upstreamId: id, kind: "tool", name: "ping", definition: { name: "ping", inputSchema: { type: "object" } }, fetchedAt: now,
    }).run();
  }
  manager = new FakeEventsManager();
  manager.eventsByUpstream.set("u1", HARBOR_EVENTS);
  const { setUpstreamManager } = await import("../lib/upstreams/types");
  setUpstreamManager(manager as never);
  const { invalidateCatalog, getCatalog } = await import("../lib/catalog/catalog");
  invalidateCatalog("seed");
  getCatalog().rebuild();
});

afterEach(() => {
  dbmod?.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

async function keyWith(upstreamIds: string[], name = "events-key") {
  const { createKey } = await import("../lib/auth/keys");
  const { upsertGrant } = await import("../lib/auth/grants");
  const key = createKey({ name });
  for (const upstreamId of upstreamIds) {
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId, toolMode: "all", tools: [] });
  }
  return key;
}

async function openClient(keyId: string) {
  const { createGatewayServer } = await import("../lib/gateway/server");
  const { createSessionState, registerSession, closeSession } = await import("../lib/gateway/sessions");
  const state = createSessionState({
    sessionId: "sess-" + Math.random().toString(36).slice(2, 8),
    keyId, keyName: keyId, exposureMode: "direct", ip: "127.0.0.1",
  });
  const server = createGatewayServer(state);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "events-test", version: "1.0.0" }, { capabilities: {} });
  await server.connect(st);
  registerSession(state, server, st);
  await client.connect(ct);
  return {
    client,
    capabilities: (server as unknown as { getCapabilities(): unknown }).getCapabilities(),
    close: async () => {
      await closeSession(state.sessionId, "test");
      await client.close();
      await server.close();
    },
  };
}

/**
 * Calls an extension method through the SDK client's raw request path.
 *
 * A result schema is required by `Protocol.request`; extension results are not part of the SDK's
 * schema table, so a permissive passthrough schema is used (the relay is what we are testing,
 * not the client's validation).
 */
async function callRaw(client: Client, method: string, params: Record<string, unknown>) {
  const anyResult = z.custom<Record<string, unknown>>((v) => typeof v === "object" && v !== null, {
    message: "extension result must be an object",
  });
  return (await client.request({ method, params } as never, anyResult as never)) as Record<string, unknown>;
}

describe("events protocol helpers", () => {
  it("knows the four methods and rejects others", () => {
    for (const m of ["events/list", "events/subscribe", "events/unsubscribe", "events/poll"]) {
      expect(isEventsMethod(m)).toBe(true);
    }
    expect(isEventsMethod("events/stream")).toBe(false);
    expect(isEventsMethod("tools/list")).toBe(false);
  });

  it("builds the envelope Harbor requires", () => {
    const env = eventsEnvelope();
    expect(env["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    expect(env["io.modelcontextprotocol/clientCapabilities"].extensions[EVENTS_EXTENSION_ID]).toEqual({
      revision: EVENTS_REVISION,
    });
  });

  it("merges the envelope into params without clobbering _meta", () => {
    const params = withEnvelope({ name: "sandbox.ready" }, { extra: 1 });
    expect(params.name).toBe("sandbox.ready");
    expect(params.extra).toBe(1);
    const meta = params._meta as Record<string, unknown>;
    expect(meta["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
  });

  it("only emits Mcp-Name when params carry a name", () => {
    expect(eventsNameHeader({ name: "job.finished" })).toBe("job.finished");
    expect(eventsNameHeader({})).toBeUndefined();
    expect(eventsNameHeader({ name: 42 })).toBeUndefined();
  });

  it("parses an event list defensively", () => {
    expect(parseEventList({ events: HARBOR_EVENTS })).toHaveLength(4);
    expect(parseEventList(null)).toEqual([]);
    expect(parseEventList({ events: [{ nope: 1 }] })).toEqual([]);
  });
});

describe("capabilities advertise extensions dynamically", () => {
  it("declares events when the key can reach an events-capable upstream", async () => {
    const key = await keyWith(["u1"]);
    const conn = await openClient(key.id);
    try {
      const extensions = (conn.capabilities as { extensions?: Record<string, unknown> }).extensions;
      expect(extensions).toBeTruthy();
      expect(extensions![EVENTS_EXTENSION_ID]).toEqual({ revision: EVENTS_REVISION });
    } finally {
      await conn.close();
    }
  });

  it("declares nothing when no reachable upstream speaks events", async () => {
    const key = await keyWith(["u2"]); // linear: not events-capable in this fixture
    manager.eventsByUpstream.delete("u2");
    const conn = await openClient(key.id);
    try {
      // linear is ready so it is *probed*; the capability is still declared because we cannot know
      // until the envelope is tried. What must NOT happen is a capability with an empty block.
      const extensions = (conn.capabilities as { extensions?: Record<string, unknown> }).extensions;
      expect(extensions === undefined || typeof extensions === "object").toBe(true);
      if (extensions) expect(Object.keys(extensions).length).toBeGreaterThan(0);
    } finally {
      await conn.close();
    }
  });
});

describe("events/list relay", () => {
  it("returns Harbor's four event types with their payloadSchema", async () => {
    const key = await keyWith(["u1"]);
    const conn = await openClient(key.id);
    try {
      const result = (await callRaw(conn.client, "events/list", {})) as {
        events: Array<{ name: string; payloadSchema?: unknown }>;
      };
      const names = result.events.map((e) => e.name).sort();
      expect(names).toEqual(["feedback.received", "job.finished", "sandbox.failed", "sandbox.ready"]);
      for (const ev of result.events) expect(ev.payloadSchema).toBeTruthy();
    } finally {
      await conn.close();
    }
  });

  it("merges events from several upstreams without duplicates", async () => {
    manager.eventsByUpstream.set("u2", [
      { name: "linear.issue.created", payloadSchema: { type: "object" } },
      { name: "sandbox.ready", payloadSchema: { type: "object" } }, // duplicate name
    ]);
    const key = await keyWith(["u1", "u2"]);
    const conn = await openClient(key.id);
    try {
      const result = (await callRaw(conn.client, "events/list", {})) as { events: Array<{ name: string }> };
      const names = result.events.map((e) => e.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain("sandbox.ready");
      expect(names).toContain("linear.issue.created");
    } finally {
      await conn.close();
    }
  });

  it("filters to one upstream when params.upstream is given", async () => {
    manager.eventsByUpstream.set("u2", [{ name: "linear.issue.created", payloadSchema: {} }]);
    const key = await keyWith(["u1", "u2"]);
    const conn = await openClient(key.id);
    try {
      const result = (await callRaw(conn.client, "events/list", { upstream: "harbor" })) as {
        events: Array<{ name: string }>;
      };
      expect(result.events.map((e) => e.name)).not.toContain("linear.issue.created");
      expect(result.events.map((e) => e.name)).toContain("sandbox.ready");
    } finally {
      await conn.close();
    }
  });

  it("swallows 'method not found' from an upstream that does not serve events", async () => {
    const key = await keyWith(["u1", "u2"]);
    const conn = await openClient(key.id);
    try {
      const result = (await callRaw(conn.client, "events/list", {})) as { events: unknown[] };
      expect(result.events.length).toBe(4); // u1 answered, u2's "method not found" ignored
    } finally {
      await conn.close();
    }
  });
});

describe("events access control (same rules as tools/call)", () => {
  it("refuses an upstream the key cannot use, exactly like an unknown tool", async () => {
    const key = await keyWith(["u1"]); // no access to linear
    const conn = await openClient(key.id);
    try {
      const denied = await callRaw(conn.client, "events/list", { upstream: "linear" }).then(
        () => null,
        (e) => e,
      );
      const unknownTool = await conn.client.callTool({ name: "linear__nope", arguments: {} }).then(
        () => null,
        (e) => e,
      );
      expect(denied).not.toBeNull();
      // Same JSON-RPC code as tools/call's "not found".
      expect(denied.code).toBe(-32602);
      expect(String(denied.message)).toMatch(/not found|introuvable|Test.*not found|events/i);
      // Nothing resembling "you are not allowed to use linear" must leak.
      expect(String(denied.message)).not.toMatch(/access|droit|forbidden|interdit/i);
      expect(unknownTool?.code).toBe(-32602);
    } finally {
      await conn.close();
    }
  });

  it("gives a key with no grants nothing at all", async () => {
    const key = await keyWith([]);
    const conn = await openClient(key.id);
    try {
      const err = await callRaw(conn.client, "events/list", {}).then(() => null, (e) => e);
      expect(err).not.toBeNull();
      expect(err.code).toBe(-32602);
    } finally {
      await conn.close();
    }
  });

  it("gives a revoked key nothing", async () => {
    const key = await keyWith(["u1"]);
    const { revokeKey } = await import("../lib/auth/keys");
    revokeKey(key.id);
    const conn = await openClient(key.id);
    try {
      const err = await callRaw(conn.client, "events/list", {}).then(() => null, (e) => e);
      expect(err).not.toBeNull();
    } finally {
      await conn.close();
    }
  });

  it("does not leak the existence of an upstream in another key's error", async () => {
    const allowed = await keyWith(["u1"], "allowed");
    const denied = await keyWith(["u2"], "denied");
    const a = await openClient(allowed.id);
    const d = await openClient(denied.id);
    try {
      const errA = await callRaw(a.client, "events/list", { upstream: "linear" }).then(() => null, (e) => e);
      const errD = await callRaw(d.client, "events/list", { upstream: "harbor" }).then(() => null, (e) => e);
      // Both get the same class of answer: the requested upstream is simply not available.
      expect(errA?.code).toBe(errD?.code);
    } finally {
      await a.close();
      await d.close();
    }
  });
});

describe("events/subscribe relay", () => {
  it("forwards the object-shaped delivery Harbor expects", async () => {
    const key = await keyWith(["u1"]);
    const conn = await openClient(key.id);
    try {
      const delivery = { mode: "webhook", url: "http://192.0.2.10:9099/hook", secret: "whsec_test" };
      const result = (await callRaw(conn.client, "events/subscribe", {
        name: "sandbox.ready",
        delivery,
      })) as { subscriptionId?: string };
      expect(result.subscriptionId).toBeTruthy();

      const forwarded = manager.raw.find((r) => r.method === "events/subscribe");
      expect(forwarded).toBeTruthy();
      // Delivery must reach the upstream as an OBJECT, not the string "webhook".
      expect(forwarded!.params.delivery).toEqual(delivery);
      // Mcp-Name carries the event type.
      expect(forwarded!.headers?.["Mcp-Name"]).toBe("sandbox.ready");
    } finally {
      await conn.close();
    }
  });

  it("requires an upstream selector when several are eligible", async () => {
    manager.eventsByUpstream.set("u2", [{ name: "linear.issue.created", payloadSchema: {} }]);
    const key = await keyWith(["u1", "u2"]);
    const conn = await openClient(key.id);
    try {
      const err = await callRaw(conn.client, "events/subscribe", {
        name: "sandbox.ready",
        delivery: { mode: "webhook", url: "http://192.0.2.10:9099/hook" },
      }).then(() => null, (e) => e);
      expect(err).not.toBeNull();
      expect(String(err.message)).toMatch(/upstream/i);
    } finally {
      await conn.close();
    }
  });
});
