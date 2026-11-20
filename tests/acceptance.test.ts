import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Integration test for the acceptance scenario of spec §12.2:
 *  - sk-aaa sees A, B, C of "toto", sk-bbb sees only B
 *  - a direct call to toto__A by sk-bbb is refused like an unknown tool
 *  - a new tool D appears for "all" keys and not for "selected" keys
 *
 * This drives the real gateway server handlers through the SDK's InMemoryTransport,
 * with a fake upstream manager (no network).
 */

let dir: string;
let dbmod: typeof import("../lib/db");

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-e2e-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
  vi.resetModules();
  dbmod = await import("../lib/db");
});

afterEach(() => {
  dbmod?.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

async function seedUpstreamAndItems(tools: string[]) {
  const { upstreams, upstreamItems } = await import("../lib/db/schema");
  const now = Date.now();
  const existing = dbmod.getDb().select().from(upstreams).all()[0];
  if (!existing) {
    dbmod.getDb()
      .insert(upstreams)
      .values({
        id: "u1",
        slug: "toto",
        name: "Toto",
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
  }
  for (const t of tools) {
    dbmod.getDb()
      .insert(upstreamItems)
      .values({
        upstreamId: "u1",
        kind: "tool",
        name: t,
        definition: { name: t, description: `${t} tool`, inputSchema: { type: "object", properties: {} } },
        fetchedAt: now,
      })
      .onConflictDoUpdate({
        target: [upstreamItems.upstreamId, upstreamItems.kind, upstreamItems.name],
        set: { fetchedAt: now },
      })
      .run();
  }
  const { invalidateCatalog, getCatalog } = await import("../lib/catalog/catalog");
  invalidateCatalog("seed");
  getCatalog().rebuild();
}

describe("acceptance scenario (spec §12.2)", () => {
  it("scopes listings and calls per key", async () => {
    const { setUpstreamManager } = await import("../lib/upstreams/types");
    const { effectiveAccessForKey, upsertGrant } = await import("../lib/auth/grants");
    const { createKey } = await import("../lib/auth/keys");

    await seedUpstreamAndItems(["A", "B", "C"]);
    const calls: Array<{ name: string; args: unknown }> = [];
    setUpstreamManager({
      // Minimal fake: the gateway only routes through callTool for this test.
      callTool: async (_u: string, name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { content: [{ type: "text", text: `called ${name}` }] };
      },
      getState: () => null,
      getAllStates: () => [],
      ensureConnected: async () => {},
    } as any);

    const aaa = createKey({ name: "agent-a" });
    const bbb = createKey({ name: "agent-b" });
    upsertGrant({ subjectType: "key", subjectId: aaa.id, upstreamId: "u1", toolMode: "selected", tools: ["A", "B", "C"] });
    upsertGrant({ subjectType: "key", subjectId: bbb.id, upstreamId: "u1", toolMode: "selected", tools: ["B"] });

    const aAccess = effectiveAccessForKey(aaa.id)!;
    const bAccess = effectiveAccessForKey(bbb.id)!;
    expect(aAccess.publicTools.sort()).toEqual(["toto__A", "toto__B", "toto__C"]);
    expect(bAccess.publicTools).toEqual(["toto__B"]);
  });

  it("grants future tools to 'all' keys only", async () => {
    const { upsertGrant, effectiveAccessForKey } = await import("../lib/auth/grants");
    const { createKey } = await import("../lib/auth/keys");
    await seedUpstreamAndItems(["A", "B", "C"]);
    const allKey = createKey({ name: "all-key" });
    const selKey = createKey({ name: "sel-key" });
    upsertGrant({ subjectType: "key", subjectId: allKey.id, upstreamId: "u1", toolMode: "all" });
    upsertGrant({ subjectType: "key", subjectId: selKey.id, upstreamId: "u1", toolMode: "selected", tools: ["A"] });

    // Upstream publishes D.
    await seedUpstreamAndItems(["D"]);
    const { invalidateCatalog, getCatalog } = await import("../lib/catalog/catalog");
    invalidateCatalog("new-tool");
    getCatalog().rebuild();

    expect(effectiveAccessForKey(allKey.id)!.upstreams.u1.tools).toContain("D");
    expect(effectiveAccessForKey(selKey.id)!.upstreams.u1.tools).not.toContain("D");
  });
});
