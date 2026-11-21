/**
 * `GET /api/v1/upstreams/{id}/events` — the admin endpoint behind the "Événements" tab.
 *
 * The panel fetches this; a shape drift would leave the tab silently empty, so the contract is
 * pinned here: the four states (supported, protocol-but-not-implemented, transport-unsupported,
 * unknown id) and the fields the UI reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

let dir: string;
let dbmod: typeof import("../lib/db");

const HARBOR_EVENTS = [
  { name: "sandbox.ready", description: "ready", delivery: ["poll", "push", "webhook"], payloadSchema: { type: "object" } },
  { name: "sandbox.failed", delivery: ["poll", "webhook"], payloadSchema: { type: "object" } },
  { name: "job.finished", delivery: ["poll", "webhook"], payloadSchema: { type: "object" } },
  { name: "feedback.received", delivery: ["poll", "webhook"], payloadSchema: { type: "object" } },
];

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-events-api-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 61).toString("base64");
  process.env.SWITCHBOARD_SECRET = "test-secret-that-is-long-enough-32";
  process.env.SWITCHBOARD_ADMIN_PASSWORD = "pw";
  vi.resetModules();
  dbmod = await import("../lib/db");
});

afterEach(() => {
  dbmod?.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

async function seedUpstream(id: string, slug: string, transport: "http" | "stdio" = "http") {
  const { upstreams } = await import("../lib/db/schema");
  const now = Date.now();
  dbmod.getDb().insert(upstreams).values({
    id, slug, name: slug, transport,
    url: transport === "http" ? "http://localhost:1/mcp" : null,
    command: transport === "stdio" ? "node" : null,
    authType: "none", enabled: true, startMode: "always", status: "ready",
    createdAt: now, updatedAt: now,
  }).run();
}

/** Manager whose rawRequest answers `events/list` for known ids. */
async function installManager(behaviour: (id: string) => Promise<unknown>) {
  const { setUpstreamManager } = await import("../lib/upstreams/types");
  setUpstreamManager({
    async startAll() {}, async shutdown() {}, async ensureConnected() {}, async disconnect() {},
    async restart() {}, async reload() {}, async remove() {},
    getState: (id: string) => ({
      id, slug: id, status: "ready" as const, lastError: null, serverInfo: null,
      capabilities: null, stderr: [], toolCount: 0,
    }),
    getAllStates: () => [], getStderr: () => [], listTools: async () => [], ping: async () => true,
    async callTool() { return { content: [] }; }, extensions: () => ({}),
    rawRequest: (id: string) => behaviour(id),
    async listPrompts() { return []; }, async getPrompt() { return { messages: [] }; },
    async listResources() { return []; }, async listResourceTemplates() { return []; },
    async readResource() { return { contents: [] }; }, async subscribeResource() {},
    async unsubscribeResource() {}, async startOAuth() { return { authorizationUrl: "" }; },
    async completeOAuth() {}, async testConfig() { return { ok: true }; },
  } as never);
}

/** Authenticated admin request: the guard accepts the admin-scope key path and the cookie path. */
async function adminRequest(): Promise<Request> {
  const { createKey } = await import("../lib/auth/keys");
  const key = createKey({ name: "admin-key", scope: "admin" });
  return new Request("http://localhost/api/v1/upstreams/x/events", {
    headers: { authorization: "Bearer " + key.secret },
  });
}

async function callRoute(upstreamId: string, req?: Request) {
  const { GET } = await import("../app/api/v1/upstreams/[id]/events/route");
  const request = req ?? (await adminRequest());
  return GET(request as never, { params: Promise.resolve({ id: upstreamId }) });
}

describe("GET /upstreams/{id}/events", () => {
  it("returns the supported contract the UI reads", async () => {
    await seedUpstream("u1", "harbor");
    await installManager(async () => ({ events: HARBOR_EVENTS }));

    const res = await callRoute("u1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;

    expect(body.supported).toBe(true);
    expect(body.revision).toBe("2026-07-28");
    expect(body.extension).toBe("io.modelcontextprotocol/events");
    expect(Array.isArray(body.methods)).toBe(true);
    expect(body.events as unknown[]).toHaveLength(4);
    for (const ev of body.events as Array<Record<string, unknown>>) {
      expect(typeof ev.name).toBe("string");
      expect(Array.isArray(ev.delivery)).toBe(true);
      expect(ev.payloadSchema).toBeTruthy();
    }
    expect((body.upstream as Record<string, unknown>).slug).toBe("harbor");
  });

  it("reports supported:false when the server does not implement the extension", async () => {
    await seedUpstream("u1", "plain");
    await installManager(async () => {
      throw new Error("Method not found");
    });

    const res = await callRoute("u1");
    expect(res.status).toBe(200); // a normal state, not a failure
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.supported).toBe(false);
    expect(String(body.reason)).toMatch(/ne sert pas|méthode inconnue/i);
    expect(body.events).toEqual([]);
  });

  it("reports supported:false for a stdio upstream without calling it", async () => {
    await seedUpstream("u1", "stdio1", "stdio");
    await installManager(async () => ({ events: HARBOR_EVENTS }));

    const res = await callRoute("u1");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.supported).toBe(false);
    expect(String(body.reason)).toMatch(/stdio/i);
  });

  it("surfaces a genuine failure as a reason with error:true", async () => {
    await seedUpstream("u1", "broken");
    await installManager(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:1");
    });

    const res = await callRoute("u1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.supported).toBe(false);
    expect(body.error).toBe(true);
    expect(String(body.reason)).toContain("ECONNREFUSED");
  });

  it("404s for an unknown upstream", async () => {
    await installManager(async () => ({ events: [] }));
    const res = await callRoute("nope");
    expect(res.status).toBe(404);
  });

  it("refuses an unauthenticated request", async () => {
    await seedUpstream("u1", "harbor");
    await installManager(async () => ({ events: HARBOR_EVENTS }));
    const res = await callRoute("u1", new Request("http://localhost/api/v1/upstreams/u1/events"));
    expect(res.status).toBe(401);
  });

  it("refuses an agent-scope key", async () => {
    await seedUpstream("u1", "harbor");
    await installManager(async () => ({ events: HARBOR_EVENTS }));
    const { createKey } = await import("../lib/auth/keys");
    const agent = createKey({ name: "agent-only" });
    const res = await callRoute(
      "u1",
      new Request("http://localhost/api/v1/upstreams/u1/events", {
        headers: { authorization: "Bearer " + agent.secret },
      }),
    );
    expect(res.status).toBe(403);
  });
});
