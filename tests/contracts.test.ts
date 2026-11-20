import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Contract tests for cross-module invariants from spec §12.2 / §5:
 *  - every public tool name matches [a-zA-Z0-9_-]+ and is <= 46 chars
 *  - every public tool name routes back to exactly one upstream+original name
 *  - the reserved name report_feedback never collides with an upstream tool
 */

let dir: string;
let dbmod: typeof import("../lib/db");

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-contract-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 13).toString("base64");
  vi.resetModules();
  dbmod = await import("../lib/db");
});

afterEach(() => {
  dbmod?.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

async function addUpstream(id: string, slug: string, tools: Array<{ name: string; long?: boolean }>) {
  const { upstreams, upstreamItems } = await import("../lib/db/schema");
  const now = Date.now();
  dbmod.getDb()
    .insert(upstreams)
    .values({
      id,
      slug,
      name: slug,
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
  for (const t of tools) {
    dbmod.getDb()
      .insert(upstreamItems)
      .values({
        upstreamId: id,
        kind: "tool",
        name: t.name,
        definition: { name: t.name, description: "x", inputSchema: { type: "object", properties: {} } },
        fetchedAt: now,
      })
      .run();
  }
}

describe("public name invariants", () => {
  it("keeps every generated name valid and short", async () => {
    await addUpstream("u1", "gh", [
      { name: "create_issue" },
      { name: "list repositories with a very long descriptive name that goes on and on forever" },
      { name: "UPPERCASE_ok" },
      { name: "dash-ok" },
      { name: "dots.are.not.allowed" },
    ]);
    const { getCatalogSnapshot } = await import("../lib/catalog/catalog");
    const snap = getCatalogSnapshot();
    expect(snap.upstreams.u1.tools.length).toBe(5);
    for (const tool of snap.upstreams.u1.tools) {
      expect(tool.publicName).toMatch(/^[a-zA-Z0-9_-]+$/);
      expect(tool.publicName.length).toBeLessThanOrEqual(46);
    }
  });

  it("routes every public name back to exactly one upstream and original name", async () => {
    await addUpstream("u1", "gh", [{ name: "create_issue" }, { name: "list_repos" }]);
    await addUpstream("u2", "jira", [{ name: "search" }]);
    const { getCatalogSnapshot, resolvePublicTool } = await import("../lib/catalog/catalog");
    const snap = getCatalogSnapshot();
    const all = [...Object.values(snap.upstreams)].flatMap((u) => u.tools);
    expect(all.length).toBe(3);
    for (const tool of all) {
      const resolved = resolvePublicTool(tool.publicName);
      expect(resolved).not.toBeNull();
      expect(resolved!.upstreamId).toBe(tool.upstreamId);
      expect(resolved!.originalName).toBe(tool.name);
    }
  });

  it("reserved report_feedback cannot be produced by an upstream", async () => {
    // Even a malicious upstream tool literally named report_feedback gets prefixed.
    await addUpstream("u1", "evil", [{ name: "report_feedback" }]);
    const { getCatalogSnapshot, resolvePublicTool } = await import("../lib/catalog/catalog");
    const snap = getCatalogSnapshot();
    const publicName = snap.upstreams.u1.tools[0].publicName;
    expect(publicName).toBe("evil__report_feedback");
    expect(publicName).not.toBe("report_feedback");
    expect(resolvePublicTool("report_feedback")).toBeNull();
  });

  it("disambiguates two upstreams exposing the same tool name", async () => {
    await addUpstream("u1", "a", [{ name: "search" }]);
    await addUpstream("u2", "b", [{ name: "search" }]);
    const { getCatalogSnapshot } = await import("../lib/catalog/catalog");
    const snap = getCatalogSnapshot();
    const names = [snap.upstreams.u1.tools[0].publicName, snap.upstreams.u2.tools[0].publicName];
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(["a__search", "b__search"]);
  });

  it("never lets an override alias collide with another upstream's tool", async () => {
    await addUpstream("u1", "gh", [{ name: "a" }]);
    const { setOverride } = await import("../lib/catalog/overrides");
    // An alias containing illegal chars is sanitised by naming.ts.
    setOverride("u1", "tool", "a", { alias: "strange alias/with chars" });
    const { invalidateCatalog, getCatalogSnapshot } = await import("../lib/catalog/catalog");
    invalidateCatalog("alias");
    const snap = getCatalogSnapshot();
    expect(snap.upstreams.u1.tools[0].publicName).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(snap.upstreams.u1.tools[0].publicName.length).toBeLessThanOrEqual(46);
  });
});
