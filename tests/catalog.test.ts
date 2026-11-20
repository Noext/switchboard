import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;
let dbmod: typeof import("../lib/db");

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-catalog-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
  vi.resetModules();
  dbmod = await import("../lib/db");
});

afterEach(() => {
  dbmod?.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

async function insertUpstream(id: string, slug: string, status: "ready" | "error" | "connecting" | "degraded" | "auth_required" | "disabled" = "ready") {
  const { upstreams } = await import("../lib/db/schema");
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
      status,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

async function insertItems(upstreamId: string, kind: string, names: string[], def: (n: string) => unknown = (n) => ({ name: n, description: "d " + n })) {
  const { upstreamItems } = await import("../lib/db/schema");
  const now = Date.now();
  for (const name of names) {
    dbmod.getDb()
      .insert(upstreamItems)
      .values({ upstreamId, kind: kind as any, name, definition: def(name) as any, fetchedAt: now })
      .run();
  }
}

describe("catalog", () => {
  it("prefixed public names for tools and prompts", async () => {
    await insertUpstream("u1", "gh");
    await insertItems("u1", "tool", ["create_issue", "list_repos"]);
    await insertItems("u1", "prompt", ["review"]);
    const { getCatalogSnapshot } = await import("../lib/catalog/catalog");
    const snap = getCatalogSnapshot();
    expect(snap.upstreams.u1.tools.map((t) => t.publicName)).toEqual(["gh__create_issue", "gh__list_repos"]);
    expect(snap.upstreams.u1.prompts.map((p) => p.publicName)).toEqual(["gh__review"]);
    expect(snap.toolsByPublicName.get("gh__create_issue")?.originalName).toBe("create_issue");
  });

  it("increments the version on rebuild", async () => {
    await insertUpstream("u1", "gh");
    const { getCatalog } = await import("../lib/catalog/catalog");
    const v1 = getCatalog().rebuild().version;
    const v2 = getCatalog().rebuild().version;
    expect(v2).toBe(v1 + 1);
  });

  it("keeps resources as-is when unique and rewrites collisions", async () => {
    await insertUpstream("u1", "a");
    await insertUpstream("u2", "b");
    await insertItems("u1", "resource", ["file:///x"]);
    await insertItems("u2", "resource", ["file:///x"]);
    await insertItems("u1", "resource", ["file:///unique"]);
    const { getCatalogSnapshot } = await import("../lib/catalog/catalog");
    const snap = getCatalogSnapshot();
    const aUris = snap.upstreams.u1.resources.map((r) => r.publicName);
    expect(aUris).toContain("file:///unique");
    expect(aUris).toContain("switchboard://a/file%3A%2F%2F%2Fx");
    expect(snap.upstreams.u2.resources[0].publicName).toBe("switchboard://b/file%3A%2F%2F%2Fx");
  });

  it("applies overrides: alias, description, disabled", async () => {
    await insertUpstream("u1", "gh");
    await insertItems("u1", "tool", ["create_issue"]);
    const { setOverride } = await import("../lib/catalog/overrides");
    setOverride("u1", "tool", "create_issue", { alias: "open_issue", descriptionOverride: "Opens an issue" });
    const { getCatalogSnapshot, invalidateCatalog } = await import("../lib/catalog/catalog");
    invalidateCatalog("test");
    const snap = getCatalogSnapshot();
    const t = snap.upstreams.u1.tools[0];
    expect(t.publicName).toBe("gh__open_issue");
    expect(t.description).toBe("Opens an issue");
    expect(snap.toolsByPublicName.get("gh__open_issue")?.originalName).toBe("create_issue");
    expect(snap.toolsByPublicName.has("gh__create_issue")).toBe(false);
  });

  it("marks disabled items as disabled in the catalog (access layer then hides them)", async () => {
    await insertUpstream("u1", "gh");
    await insertItems("u1", "tool", ["a", "b"]);
    const { setOverride } = await import("../lib/catalog/overrides");
    setOverride("u1", "tool", "a", { enabled: false });
    const { getCatalogSnapshot, invalidateCatalog } = await import("../lib/catalog/catalog");
    invalidateCatalog("test");
    const snap = getCatalogSnapshot();
    expect(snap.upstreams.u1.tools.map((t) => [t.name, t.enabled])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  it("resolvePublicTool finds the routing target", async () => {
    await insertUpstream("u1", "jira");
    await insertItems("u1", "tool", ["search"]);
    const { resolvePublicTool } = await import("../lib/catalog/catalog");
    const r = resolvePublicTool("jira__search");
    expect(r?.upstreamId).toBe("u1");
    expect(r?.originalName).toBe("search");
    expect(resolvePublicTool("nope__x")).toBeNull();
  });

  it("notifies subscribers through the debounced invalidate()", async () => {
    await insertUpstream("u1", "gh");
    const { getCatalog, onCatalogChanged, invalidateCatalog } = await import("../lib/catalog/catalog");
    getCatalog().rebuild();
    const events: number[] = [];
    const off = onCatalogChanged((e) => events.push(e.version));
    invalidateCatalog("test1");
    invalidateCatalog("test2");
    await new Promise((r) => setTimeout(r, 700));
    expect(events.length).toBe(1);
    off();
  });

  it("visibleToolsFor returns only catalog entries the access allows", async () => {
    await insertUpstream("u1", "gh");
    await insertItems("u1", "tool", ["a", "b", "c"]);
    const { visibleToolsFor } = await import("../lib/catalog/catalog");
    const out = visibleToolsFor({ upstreams: { u1: { tools: ["b"] } } });
    expect(out.map((e) => e.publicName)).toEqual(["gh__b"]);
  });
});
