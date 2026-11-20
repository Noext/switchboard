import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { encryptJson } from "../lib/crypto";
import { getDb } from "../lib/db";
import { oauthStates, toolDiscoveries, upstreamItems, upstreams } from "../lib/db/schema";
import { getRedactor } from "../lib/redact";
import { Manager, createUpstreamManager, isAuthRequired, isTransportFailure } from "../lib/upstreams/manager";
import { buildHttpHeaders, isSseFallbackError } from "../lib/upstreams/http";
import { StderrRing, buildStdioEnv } from "../lib/upstreams/stdio";
import { HealthMonitor, backoffDelay, MAX_FAILURES_BEFORE_ERROR, ERROR_RETRY_MS } from "../lib/upstreams/health";
import { DbOAuthStore, OAuthManager, createSignedState, verifySignedState } from "../lib/upstreams/oauth";
import { resolveUpstream, decodeSecretJson } from "../lib/upstreams/config";
import { getUpstreamManager } from "../lib/upstreams/types";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "stdio-server.mjs");

let dataDir: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "sb-upstreams-"));
  process.env.SWITCHBOARD_DATA_DIR = dataDir;
  process.env.SWITCHBOARD_SECRET = "test-secret-that-is-long-enough-32";
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.SWITCHBOARD_PUBLIC_URL = "http://localhost:3000";
  const db = await import("../lib/db");
  db.closeDb();
});

afterAll(async () => {
  const db = await import("../lib/db");
  db.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Every test starts from an empty upstream table.
  const db = getDb();
  db.delete(upstreamItems).run();
  db.delete(toolDiscoveries).run();
  db.delete(oauthStates).run();
  db.delete(upstreams).run();
});

/** Inserts an upstream row and returns its id. */
function insertRow(overrides: Partial<typeof upstreams.$inferInsert> & { slug: string }): string {
  const now = Date.now();
  const id = overrides.id ?? "u-" + Math.random().toString(36).slice(2, 10);
  getDb()
    .insert(upstreams)
    .values({
      id,
      slug: overrides.slug,
      name: overrides.name ?? overrides.slug,
      transport: overrides.transport ?? "stdio",
      url: overrides.url ?? null,
      command: overrides.command ?? null,
      args: overrides.args ?? null,
      cwd: overrides.cwd ?? null,
      envEnc: overrides.envEnc ?? null,
      headersEnc: overrides.headersEnc ?? null,
      authType: overrides.authType ?? "none",
      oauthEnc: overrides.oauthEnc ?? null,
      enabled: overrides.enabled ?? true,
      startMode: overrides.startMode ?? "always",
      idleStopMinutes: overrides.idleStopMinutes ?? 15,
      callTimeoutSeconds: overrides.callTimeoutSeconds ?? 120,
      status: overrides.status ?? "connecting",
      lastError: overrides.lastError ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

function stdioRow(overrides: Partial<typeof upstreams.$inferInsert> = {}): string {
  return insertRow({
    slug: overrides.slug ?? "fix",
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE],
    ...overrides,
  });
}

function encodeSecret(value: unknown): string {
  return encryptJson(value).toString("base64");
}

// ---------------------------------------------------------------------------
// stdio: env isolation + ring buffer (pure functions, no DB)
// ---------------------------------------------------------------------------

describe("stdio env isolation (spec §10)", () => {
  it("passes only the declared env plus PATH and HOME", () => {
    const env = buildStdioEnv({ FOO: "bar", SWITCHBOARD_MASTER_KEY: "leaked" }, {
      PATH: "/usr/bin",
      HOME: "/root",
      SHELL: "/bin/bash",
      USER: "root",
      SWITCHBOARD_ADMIN_PASSWORD: "super-secret",
      NODE_ENV: "test",
    } as NodeJS.ProcessEnv);
    expect(env.FOO).toBe("bar");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/root");
    // Inherited-but-not-allowed keys are blanked, never passed through.
    expect(env.SHELL).toBe("");
    expect(env.USER).toBe("");
    expect(env.SWITCHBOARD_ADMIN_PASSWORD).toBeUndefined();
  });

  it("cannot leak the gateway master key even when it is set in process.env", () => {
    const previous = process.env.SWITCHBOARD_MASTER_KEY;
    process.env.SWITCHBOARD_MASTER_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=";
    try {
      const env = buildStdioEnv({}, process.env);
      expect(env.SWITCHBOARD_MASTER_KEY).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain("aaaaaaaaaaaaaaaa");
    } finally {
      if (previous === undefined) delete process.env.SWITCHBOARD_MASTER_KEY;
      else process.env.SWITCHBOARD_MASTER_KEY = previous;
    }
  });
});

describe("stderr ring buffer", () => {
  it("keeps only the last N lines and reassembles partial lines", () => {
    const ring = new StderrRing(3);
    ring.push("one\ntwo\n");
    ring.push("thr");
    ring.push("ee\nfour\nfi");
    ring.flush();
    expect(ring.toArray()).toEqual(["three", "four", "fi"]);
    expect(ring.size).toBe(3);
  });

  it("defaults to 500 lines", () => {
    const ring = new StderrRing();
    for (let i = 0; i < 700; i++) ring.push(`line-${i}\n`);
    expect(ring.toArray()).toHaveLength(500);
    expect(ring.toArray()[0]).toBe("line-200");
    expect(ring.toArray().at(-1)).toBe("line-699");
  });
});

// ---------------------------------------------------------------------------
// config → transport mapping
// ---------------------------------------------------------------------------

describe("config mapping", () => {
  it("decrypts env/headers and registers the secrets with the redactor", () => {
    const id = insertRow({
      slug: "gh",
      transport: "http",
      url: "http://example.test/mcp",
      authType: "headers",
      headersEnc: encodeSecret({ "X-API-Key": "sk-very-secret-value-1234" }),
      envEnc: encodeSecret({ FOO: "secret-env-value" }),
    });
    const row = getDb().select().from(upstreams).where(eqId(id)).get();
    const resolved = resolveUpstream(row!);
    expect(resolved.headers).toEqual({ "X-API-Key": "sk-very-secret-value-1234" });
    expect(resolved.env).toEqual({ FOO: "secret-env-value" });
    const redacted = getRedactor().redact("calling with sk-very-secret-value-1234 and secret-env-value");
    expect(redacted).not.toContain("sk-very-secret-value-1234");
    expect(redacted).not.toContain("secret-env-value");
    expect(redacted).toContain("••••");
  });

  it("tolerates null and empty encrypted columns", () => {
    expect(decodeSecretJson(null)).toBeNull();
    expect(decodeSecretJson("")).toBeNull();
    expect(decodeSecretJson("   ")).toBeNull();
  });

  it("strips transport-critical headers from custom headers", () => {
    const headers = buildHttpHeaders({
      Authorization: "Bearer abc",
      "Mcp-Session-Id": "should-be-dropped",
      "mcp-protocol-version": "drop-me-too",
      "X-Custom": "kept",
    });
    expect(headers).toEqual({ Authorization: "Bearer abc", "X-Custom": "kept" });
  });

  it("fingerprints a row so config changes force a reconnect", () => {
    const id = insertRow({ slug: "fp", transport: "http", url: "http://a.test/mcp" });
    const row = getDb().select().from(upstreams).where(eqId(id)).get()!;
    const a = resolveUpstream(row).fingerprint;
    const b = resolveUpstream({ ...row, url: "http://b.test/mcp" }).fingerprint;
    expect(a).not.toBe(b);
  });
});

describe("SSE fallback detection", () => {
  it("falls back on 4xx/405 and not on 5xx", () => {
    expect(isSseFallbackError({ code: 405, message: "nope" })).toBe(true);
    expect(isSseFallbackError({ code: 404, message: "nope" })).toBe(true);
    expect(isSseFallbackError({ code: 500, message: "boom" })).toBe(false);
    expect(isSseFallbackError(new Error("HTTP 405 Method Not Allowed"))).toBe(true);
    expect(isSseFallbackError(new Error("socket hang up"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// health / backoff
// ---------------------------------------------------------------------------

describe("health backoff (spec §4.3)", () => {
  it("follows 1s → 60s and switches to a 5 minute retry after 5 failures", () => {
    expect(backoffDelay(1)).toBe(1000);
    expect(backoffDelay(2)).toBe(2000);
    expect(backoffDelay(3)).toBe(4000);
    expect(backoffDelay(4)).toBe(8000);
    expect(backoffDelay(5)).toBe(16000);
    expect(backoffDelay(9)).toBe(60000);
    expect(ERROR_RETRY_MS).toBe(300000);
    expect(MAX_FAILURES_BEFORE_ERROR).toBe(5);
  });

  it("calls onGaveUp once after MAX_FAILURES_BEFORE_ERROR and schedules the slow retry", () => {
    let gaveUp = 0;
    let lastDelay = 0;
    const monitor = new HealthMonitor({
      hooks: {
        ping: async () => false,
        reconnect: async () => false,
        onGaveUp: () => {
          gaveUp += 1;
        },
        onReconnectScheduled: (_failures, delay) => {
          lastDelay = delay;
        },
      },
    });
    for (let i = 0; i < 5; i++) monitor.reportFailure("nope");
    expect(gaveUp).toBe(1);
    expect(lastDelay).toBe(ERROR_RETRY_MS);
    monitor.stop();
  });

  it("idle stop fires after idleStopMs", async () => {
    let idleCalls = 0;
    const monitor = new HealthMonitor({
      hooks: {
        ping: async () => true,
        reconnect: async () => true,
        onIdle: () => {
          idleCalls += 1;
        },
      },
      pingIntervalMs: 0,
      idleStopMs: 30,
      idleCheckIntervalMs: 10,
    });
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    monitor.stop();
    expect(idleCalls).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Manager + real stdio fixture
// ---------------------------------------------------------------------------

describe("Manager with a real stdio upstream", () => {
  let manager: Manager;

  beforeEach(() => {
    manager = new Manager({ autoHealth: false });
  });

  it("connects, lists tools, calls a tool, and caches the listing", async () => {
    const id = stdioRow({ slug: "fix" });
    await manager.startAll();

    const state = manager.getState(id);
    expect(state?.status).toBe("ready");
    expect(state?.toolCount).toBe(7);
    expect(state?.serverInfo?.name).toBe("switchboard-stdio-fixture");

    const tools = await manager.listTools(id);
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["echo", "env_probe", "slow", "hang", "fail", "stderr_noise", "mutate_tools"]),
    );
    const echo = tools.find((t) => t.name === "echo");
    expect(echo?.inputSchema).toMatchObject({ type: "object" });

    const result = await manager.callTool(id, "echo", { text: "bonjour" });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "bonjour" }]);

    const prompts = await manager.listPrompts(id);
    expect(prompts.map((p) => p.name)).toContain("greet");
    const resources = await manager.listResources(id);
    expect(resources.map((r) => r.uri)).toContain("fixture://readme");

    // The listing is cached in upstream_items with one row per kind.
    const rows = getDb().select().from(upstreamItems).all();
    expect(rows.filter((r) => r.kind === "tool")).toHaveLength(7);
    expect(rows.filter((r) => r.kind === "prompt")).toHaveLength(1);
    expect(rows.filter((r) => r.kind === "resource")).toHaveLength(1);

    // New tools produce tool_discoveries rows.
    const discoveries = getDb().select().from(toolDiscoveries).all();
    expect(discoveries.map((d) => d.toolName).sort()).toEqual(
      ["echo", "env_probe", "fail", "hang", "slow", "stderr_noise", "mutate_tools"].sort(),
    );

    // Persisted status columns.
    const row = getDb().select().from(upstreams).where(eqId(id)).get()!;
    expect(row.status).toBe("ready");
    expect(row.lastReadyAt).toBeGreaterThan(0);
    expect(row.serverInfo).toMatchObject({ name: "switchboard-stdio-fixture" });

    await manager.shutdown();
  });

  it("returns an isError result without throwing for a failing tool", async () => {
    const id = stdioRow({ slug: "failing" });
    await manager.startAll();
    const result = await manager.callTool(id, "fail", { message: "nope" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "nope" }]);
    await manager.shutdown();
  });

  it("relays progress notifications through CallOptions.onProgress", async () => {
    const id = stdioRow({ slug: "progress" });
    await manager.startAll();
    const seen: number[] = [];
    const result = await manager.callTool(
      id,
      "slow",
      { steps: 3, delayMs: 1 },
      { onProgress: (p) => seen.push(p.progress) },
    );
    expect(result.content).toEqual([{ type: "text", text: "done after 3 steps" }]);
    expect(seen).toEqual([1, 2, 3]);
    await manager.shutdown();
  });

  it("aborts a call through the AbortSignal", async () => {
    const id = stdioRow({ slug: "abort" });
    await manager.startAll();
    const controller = new AbortController();
    const promise = manager.callTool(id, "hang", { ms: 5000 }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toBeTruthy();
    await manager.shutdown();
  });

  it("enforces the row callTimeoutSeconds", async () => {
    const id = stdioRow({ slug: "timeout", callTimeoutSeconds: 1 });
    await manager.startAll();
    // The row allows 1 s; the tool sleeps 5 s, so the call must reject rather than hang.
    await expect(manager.callTool(id, "hang", { ms: 5000 })).rejects.toBeTruthy();
    await manager.shutdown();
  });

  it("treats callTimeoutSeconds: 0 as 'no explicit timeout'", async () => {
    const id = stdioRow({ slug: "notimeout", callTimeoutSeconds: 0 });
    await manager.startAll();
    const result = await manager.callTool(id, "echo", { text: "still fine" });
    expect(result.content).toEqual([{ type: "text", text: "still fine" }]);
    await manager.shutdown();
  });

  it("isolates the child environment from the gateway (spec §10)", async () => {
    process.env.SWITCHBOARD_ADMIN_PASSWORD = "should-never-reach-the-child";
    process.env.A_SECRET_ONLY_THE_PARENT_KNOWS = "parent-only-value";
    try {
      const id = stdioRow({
        slug: "env",
        envEnc: encodeSecret({ DECLARED_ONLY: "declared-value" }),
      });
      await manager.startAll();
      const result = await manager.callTool(id, "env_probe", {});
      const payload = JSON.parse((result.content[0] as { text: string }).text) as {
        env: Record<string, string>;
        cwd: string;
        pid: number;
      };
      expect(payload.env.DECLARED_ONLY).toBe("declared-value");
      expect(payload.env.PATH).toBeTruthy();
      expect(payload.env.SWITCHBOARD_ADMIN_PASSWORD).toBeUndefined();
      expect(payload.env.A_SECRET_ONLY_THE_PARENT_KNOWS).toBeUndefined();
      expect(payload.env.SWITCHBOARD_MASTER_KEY).toBeUndefined();
      expect(payload.pid).toBeGreaterThan(0);
      // Spec §10: stderr is captured, not inherited.
      await manager.shutdown();
    } finally {
      delete process.env.A_SECRET_ONLY_THE_PARENT_KNOWS;
    }
  });

  it("keeps child stderr in the 500-line ring", async () => {
    const id = stdioRow({ slug: "stderr" });
    await manager.startAll();
    await manager.callTool(id, "stderr_noise", { line: "hello-ring" });
    // Give the pipe a tick to deliver.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(manager.getStderr(id).some((line) => line.includes("hello-ring"))).toBe(true);
    await manager.shutdown();
  });

  it("lazy stdio is primed at boot, restarted on demand, and keeps its listing", async () => {
    const id = stdioRow({ slug: "lazyup", startMode: "lazy" });
    const lazy = new Manager({ autoHealth: false });
    await lazy.startAll();

    // Spec §4.3: "listing mis en cache (pris au premier démarrage) → les outils restent
    // visibles même process arrêté". So after boot the cache is populated, the child has
    // been stopped again, and the upstream reads as ready so the catalog keeps its tools.
    expect(lazy.getState(id)?.status).toBe("ready");
    expect(lazy.getState(id)?.toolCount).toBe(7);
    // serverInfo is the last known identity, kept while the child is stopped so the UI can
    // still name the upstream.
    expect(lazy.getState(id)?.serverInfo?.name).toBe("switchboard-stdio-fixture");
    const cachedAfterBoot = getDb()
      .select()
      .from(upstreamItems)
      .all()
      .filter((r) => r.kind === "tool");
    expect(cachedAfterBoot).toHaveLength(7);
    expect(cachedAfterBoot.map((r) => r.name)).toContain("echo");

    // A call transparently restarts the child (< 30 s initialize wait per spec §4.3).
    const result = await lazy.callTool(id, "echo", { text: "lazy" });
    expect(result.content).toEqual([{ type: "text", text: "lazy" }]);
    expect(lazy.getState(id)?.serverInfo?.name).toBe("switchboard-stdio-fixture");

    // Stopping keeps the tools visible: status stays ready and the listing is intact.
    await lazy.disconnect(id);
    expect(lazy.getState(id)?.status).toBe("ready");
    expect(lazy.getState(id)?.toolCount).toBe(7);
    const cachedAfterStop = getDb()
      .select()
      .from(upstreamItems)
      .all()
      .filter((r) => r.kind === "tool");
    expect(cachedAfterStop).toHaveLength(7);

    // And it can be restarted again after the stop.
    const again = await lazy.callTool(id, "echo", { text: "again" });
    expect(again.content).toEqual([{ type: "text", text: "again" }]);
    await lazy.shutdown();
  });

  it("stops the child process on shutdown", async () => {
    const id = stdioRow({ slug: "shutdown" });
    await manager.startAll();
    const result = await manager.callTool(id, "env_probe", {});
    const pid = (JSON.parse((result.content[0] as { text: string }).text) as { pid: number }).pid;
    await manager.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 200));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });

  it("marks a broken command as error and does not throw from startAll", async () => {
    insertRow({ slug: "broken", transport: "stdio", command: "/nonexistent/binary-xyz", args: [] });
    const broken = new Manager({ autoHealth: false });
    await expect(broken.startAll()).resolves.toBeUndefined();
    const states = broken.getAllStates();
    const state = states.find((s) => s.slug === "broken");
    expect(state?.status).toBe("error");
    expect(state?.lastError).toBeTruthy();
    await broken.shutdown();
  });

  it("marks disabled upstreams as disabled and never connects them", async () => {
    const id = stdioRow({ slug: "offup", enabled: false });
    const off = createUpstreamManager({ autoHealth: false });
    await off.startAll();
    expect(off.getState(id)?.status).toBe("disabled");
    const row = getDb().select().from(upstreams).where(eqId(id)).get()!;
    expect(row.status).toBe("disabled");
    await off.shutdown();
  });

  it("registers itself with setUpstreamManager()", () => {
    const created = createUpstreamManager({ autoHealth: false });
    expect(getUpstreamManager()).toBe(created);
  });

  it("getState/getAllStates/getStderr are safe for unknown ids", () => {
    expect(manager.getState("does-not-exist")).toBeNull();
    expect(manager.getStderr("does-not-exist")).toEqual([]);
    expect(manager.getAllStates()).toEqual([]);
  });
});

describe("upstream list_changed (spec §4.3)", () => {
  it("refreshes the cache and records the new tool when the upstream announces a change", async () => {
    const id = stdioRow({ slug: "live" });
    const manager = new Manager({ autoHealth: false });
    await manager.startAll();
    expect(manager.getState(id)?.toolCount).toBe(7);

    const events: string[] = [];
    const { onUiEvent } = await import("../lib/events");
    const off = onUiEvent((event) => {
      if (event.type === "discovery.new") {
        events.push(String((event.data as { toolName?: string }).toolName));
      }
    });

    const result = await manager.callTool(id, "mutate_tools", {});
    const newTool = (result.content[0] as { text: string }).text;
    expect(newTool).toMatch(/^dynamic_tool_/);

    // The manager debounces list_changed by 250 ms before re-listing.
    await waitFor(() => manager.getState(id)?.toolCount === 8, 3000);
    off();

    const names = getDb()
      .select()
      .from(upstreamItems)
      .all()
      .filter((r) => r.kind === "tool")
      .map((r) => r.name);
    expect(names).toContain(newTool);
    expect(names).toHaveLength(8);

    const discovery = getDb()
      .select()
      .from(toolDiscoveries)
      .all()
      .map((r) => r.toolName);
    expect(discovery).toContain(newTool);
    expect(events).toContain(newTool);

    await manager.shutdown();
  });
});

describe("listing refresh", () => {
  it("deletes vanished items but keeps earlier discoveries", async () => {
    const id = stdioRow({ slug: "stale" });
    // Pre-populate a stale row that the upstream no longer reports.
    getDb()
      .insert(upstreamItems)
      .values({
        upstreamId: id,
        kind: "tool",
        name: "vanished_tool",
        definition: { name: "vanished_tool" },
        fetchedAt: Date.now(),
      })
      .run();
    const manager = new Manager({ autoHealth: false });
    await manager.startAll();
    const names = getDb()
      .select()
      .from(upstreamItems)
      .all()
      .map((r) => r.name);
    expect(names).not.toContain("vanished_tool");
    expect(names).toContain("echo");
    await manager.shutdown();
  });

  it("does not duplicate tool_discoveries on repeated refreshes", async () => {
    const id = stdioRow({ slug: "stable" });
    const manager = new Manager({ autoHealth: false });
    await manager.startAll();
    await manager.restart(id);
    const rows = getDb().select().from(toolDiscoveries).all();
    const names = rows.map((r) => r.toolName);
    expect(new Set(names).size).toBe(names.length);
    await manager.shutdown();
  });
});

// ---------------------------------------------------------------------------
// HTTP upstream against a real streamable-HTTP server
// ---------------------------------------------------------------------------

describe("HTTP upstream", () => {
  let httpServer: Server;
  let url: string;
  let sessions: Map<string, StreamableHTTPServerTransport>;

  beforeAll(async () => {
    sessions = new Map();
    httpServer = createServer(async (req, res) => {
      if (req.method === "POST" || req.method === "GET" || req.method === "DELETE") {
        if (req.url?.startsWith("/bad") ) {
          res.writeHead(405, { "content-type": "text/plain" });
          res.end("Method Not Allowed");
          return;
        }
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        let transport = sessionId ? sessions.get(sessionId) : undefined;
        if (!transport) {
          transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => "sess-" + Math.random().toString(36).slice(2) });
          transport.onclose = () => {
            if (transport!.sessionId) sessions.delete(transport!.sessionId);
          };
          const server = buildHttpFixtureServer();
          await server.connect(transport);
          await transport.handleRequest(req, res);
          if (transport.sessionId) sessions.set(transport.sessionId, transport);
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const address = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterAll(async () => {
    for (const transport of sessions.values()) await transport.close().catch(() => undefined);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("connects, lists and calls over streamable HTTP", async () => {
    const id = insertRow({ slug: "web", transport: "http", url, authType: "none" });
    const manager = new Manager({ autoHealth: false });
    await manager.startAll();
    const state = manager.getState(id);
    expect(state?.status).toBe("ready");
    expect(state?.toolCount).toBe(2);
    const tools = await manager.listTools(id);
    expect(tools.map((t) => t.name).sort()).toEqual(["http_echo", "http_env"]);
    const result = await manager.callTool(id, "http_echo", { text: "hi" });
    expect(result.content).toEqual([{ type: "text", text: "hi-http" }]);
    await manager.shutdown();
  });

  it("sends configured custom headers to the upstream", async () => {
    const id = insertRow({
      slug: "hdr",
      transport: "http",
      url: url.replace("/mcp", "/mcp?"),
      authType: "headers",
      headersEnc: encodeSecret({ "X-API-Key": "the-header-secret" }),
    });
    const manager = new Manager({ autoHealth: false });
    await manager.startAll();
    expect(manager.getState(id)?.status).toBe("ready");
    const result = await manager.callTool(id, "http_env", {});
    const payload = JSON.parse((result.content[0] as { text: string }).text) as { header: string | null };
    expect(payload.header).toBe("the-header-secret");
    await manager.shutdown();
  });

  it("reports testConfig success and failure without persisting anything", async () => {
    const manager = new Manager({ autoHealth: false });
    const ok = await manager.testConfig({ transport: "http", url, authType: "none" });
    expect(ok.ok).toBe(true);
    expect(ok.serverInfo?.name).toBe("switchboard-http-fixture");
    expect(ok.tools?.map((t) => t.name).sort()).toEqual(["http_echo", "http_env"]);

    const bad = await manager.testConfig({ transport: "http", url: "http://127.0.0.1:1/mcp", authType: "none" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();

    // Nothing was persisted by testConfig.
    expect(getDb().select().from(upstreams).all()).toHaveLength(0);
    expect(getDb().select().from(upstreamItems).all()).toHaveLength(0);
    await manager.shutdown();
  });

  it("testConfig works for a stdio candidate and always cleans up", async () => {
    const manager = new Manager({ autoHealth: false });
    const result = await manager.testConfig({
      transport: "stdio",
      command: process.execPath,
      args: [FIXTURE],
      authType: "none",
    });
    expect(result.ok).toBe(true);
    expect(result.tools?.length).toBe(7);
    await manager.shutdown();
  });

  it("ping() returns true while connected and false for an unknown upstream", async () => {
    const id = insertRow({ slug: "pingme", transport: "http", url, authType: "none" });
    const manager = new Manager({ autoHealth: false });
    await manager.startAll();
    expect(await manager.ping(id)).toBe(true);
    expect(await manager.ping("nope")).toBe(false);
    await manager.shutdown();
  });
});

describe("HTTP → SSE fallback (spec §4.1)", () => {
  let sseServer: Server;
  let sseUrl: string;

  beforeAll(async () => {
    /** A server that only speaks the legacy SSE transport: POST /mcp answers 405. */
    sseServer = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/sse") {
        const transport = new SSEServerTransport("/messages", res);
        const server = buildHttpFixtureServer();
        await server.connect(transport);
        // connect() starts the stream and assigns the session id sent in the endpoint event.
        sseTransports.set(transport.sessionId, transport);
        transport.onclose = () => sseTransports.delete(transport.sessionId);
        return;
      }
      if (req.method === "POST" && req.url?.startsWith("/messages")) {
        const transport = sseTransports.get(new URL(req.url, "http://localhost").searchParams.get("sessionId") ?? "");
        if (!transport) {
          res.writeHead(400).end("unknown session");
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }
      // The streamable transport POST endpoint rejects with 405, which is the documented
      // trigger for the client's automatic SSE fallback.
      if (req.url === "/sse" || req.url === "/mcp") {
        res.writeHead(405, { "content-type": "text/plain" }).end("Method Not Allowed");
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => sseServer.listen(0, "127.0.0.1", () => resolve()));
    sseUrl = `http://127.0.0.1:${(sseServer.address() as AddressInfo).port}/sse`;
  });

  afterAll(async () => {
    for (const transport of sseTransports.values()) await transport.close().catch(() => undefined);
    sseTransports.clear();
    await new Promise<void>((resolve) => sseServer.close(() => resolve()));
  });

  it("falls back to SSE when the streamable transport is rejected with 405", async () => {
    const { HttpUpstream } = await import("../lib/upstreams/http");
    const upstream = new HttpUpstream({
      url: sseUrl,
      transport: "http",
      authType: "none",
      clientInfo: { name: "test", version: "1" },
      capabilities: {},
    });
    const connected = await upstream.connect();
    expect(connected.kind).toBe("sse");
    expect(upstream.kind).toBe("sse");
    const tools = await connected.client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["http_echo", "http_env"]);
    await upstream.close();
  });

  it("sends custom headers on the SSE stream request too (spec §10)", async () => {
    // The legacy SSE transport reads event-stream headers from a wrapped fetch, not from
    // eventSourceInit, so this guards that the configured Authorization/API key reaches it.
    const { HttpUpstream } = await import("../lib/upstreams/http");
    const upstream = new HttpUpstream({
      url: sseUrl,
      transport: "http",
      authType: "headers",
      headers: { "X-API-Key": "sse-header-secret" },
      clientInfo: { name: "test", version: "1" },
      capabilities: {},
    });
    const connected = await upstream.connect();
    expect(connected.kind).toBe("sse");
    const result = await connected.client.callTool({ name: "http_env", arguments: {} });
    const first = (result.content as Array<{ text?: string }>)[0];
    const payload = JSON.parse(first?.text ?? "{}") as { header: string | null };
    // The POST /messages request carries requestInit headers; the assertion below is on the
    // call path, which is what the upstream actually authenticates.
    expect(payload.header).toBe("sse-header-secret");
    await upstream.close();
  });

  it("records the SSE kind in the manager and lists through it", async () => {
    const id = insertRow({ slug: "sseup", transport: "http", url: sseUrl, authType: "none" });
    const manager = new Manager({ autoHealth: false });
    await manager.startAll();
    expect(manager.getState(id)?.status).toBe("ready");
    const result = await manager.callTool(id, "http_echo", { text: "via-sse" });
    expect(result.content).toEqual([{ type: "text", text: "via-sse-http" }]);
    await manager.shutdown();
  });
});

/** SSE server-side transports, keyed by session id. */
const sseTransports = new Map<string, SSEServerTransport>();

function buildHttpFixtureServer(): McpServer {
  const server = new McpServer({ name: "switchboard-http-fixture", version: "0.1.0" });
  server.registerTool(
    "http_echo",
    { description: "echo", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text: text + "-http" }] }),
  );
  server.registerTool(
    "http_env",
    { description: "reports the X-API-Key header it received", inputSchema: {} },
    async (_args, extra) => {
      const requestInfo = (extra as { requestInfo?: { headers?: Record<string, string> } }).requestInfo;
      const header = requestInfo?.headers?.["x-api-key"] ?? null;
      return { content: [{ type: "text", text: JSON.stringify({ header }) }] };
    },
  );
  return server;
}

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

describe("OAuth state signing (spec §10)", () => {
  it("signs and verifies state, and rejects tampering", () => {
    const secret = "state-signing-secret";
    const state = createSignedState(secret);
    expect(verifySignedState(state, secret)).toBeTruthy();
    expect(verifySignedState(state, "other-secret")).toBeNull();
    expect(verifySignedState(state + "x", secret)).toBeNull();
    expect(verifySignedState("garbage", secret)).toBeNull();
    expect(verifySignedState("", secret)).toBeNull();
  });

  it("stores pending state in oauth_states with a 10 minute TTL", () => {
    const id = insertRow({ slug: "oauthup", transport: "http", url: "http://auth.test/mcp", authType: "oauth" });
    const manager = new OAuthManager({ store: makeMemoryStore(id) });
    const state = manager.state();
    expect(manager.redirectUrl).toBe("http://localhost:3000/oauth/callback");
    const row = getDb().select().from(oauthStates).where(eqState(state)).get();
    expect(row).toBeTruthy();
    expect(row!.upstreamId).toBe(id);
    expect(row!.expiresAt - row!.createdAt).toBe(10 * 60 * 1000);
    expect(verifySignedState(state, process.env.SWITCHBOARD_SECRET!)).toBeTruthy();
  });

  it("encrypts the OAuth blob in upstreams.oauth_enc", () => {
    const id = insertRow({ slug: "oauthstore", transport: "http", url: "http://auth.test/mcp", authType: "oauth" });
    const store = new DbOAuthStore(id);
    store.save({ tokens: { access_token: "at-secret", token_type: "Bearer", refresh_token: "rt-secret" } });
    const row = getDb().select().from(upstreams).where(eqId(id)).get()!;
    expect(row.oauthEnc).toBeTruthy();
    expect(row.oauthEnc).not.toContain("at-secret");
    const decoded = decodeSecretJson<{ tokens?: { access_token?: string } }>(row.oauthEnc);
    expect(decoded?.tokens?.access_token).toBe("at-secret");
    // Tokens are registered with the redactor when saved.
    expect(getRedactor().redact("token at-secret")).not.toContain("at-secret");
  });
});

describe("error classification", () => {
  it("detects auth-required and transport failures", () => {
    const unauthorized = new Error("401 Unauthorized");
    unauthorized.name = "UnauthorizedError";
    expect(isAuthRequired(unauthorized)).toBe(true);
    expect(isAuthRequired(new Error("boom"))).toBe(false);
    expect(isTransportFailure(new Error("fetch failed"))).toBe(true);
    expect(isTransportFailure(new Error("Not connected"))).toBe(true);
    expect(isTransportFailure(new Error("invalid arguments"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// In-memory transport: callTool / listTools wiring without a child process
// ---------------------------------------------------------------------------

describe("InMemoryTransport wiring", () => {
  it("lists and calls through the SDK client the manager builds", async () => {
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: "memory-fixture", version: "0.0.1" });
    server.registerTool("ping_tool", { description: "p", inputSchema: {} }, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    await server.connect(serverTransport);

    const client = new Client({ name: "test", version: "1" }, { capabilities: {} });
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["ping_tool"]);
    const result = await client.callTool({ name: "ping_tool", arguments: {} });
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Polls until `predicate` is true or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}

function eqId(id: string) {
  return eq(upstreams.id, id);
}

function eqState(state: string) {
  return eq(oauthStates.state, state);
}

/** OAuth store backed by a plain object, for tests that must not touch upstreams.oauth_enc. */
function makeMemoryStore(id: string) {
  let current: import("../lib/upstreams/config").StoredOAuthState | null = null;
  return {
    load: () => current,
    save: (state: import("../lib/upstreams/config").StoredOAuthState) => {
      current = state;
    },
    serverUrl: () => "http://auth.test/mcp",
    upstreamId: () => id,
  };
}
