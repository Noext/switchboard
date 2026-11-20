import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;
let dbmod: typeof import("../lib/db");

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-grants-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
  vi.resetModules();
  dbmod = await import("../lib/db");
});

afterEach(() => {
  dbmod?.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

async function seed() {
  const { upstreams } = await import("../lib/db/schema");
  const now = Date.now();
  dbmod.getDb()
    .insert(upstreams)
    .values({
      id: "u1",
      slug: "toto",
      name: "Toto",
      transport: "http",
      url: "http://localhost:9999/mcp",
      authType: "none",
      enabled: true,
      startMode: "always",
      status: "ready",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const { upstreamItems } = await import("../lib/db/schema");
  for (const name of ["A", "B", "C", "D"]) {
    dbmod.getDb()
      .insert(upstreamItems)
      .values({
        upstreamId: "u1",
        kind: "tool",
        name,
        definition: { name, description: name + " tool" },
        fetchedAt: now,
      })
      .run();
  }
  const { invalidateCatalog } = await import("../lib/catalog/catalog");
  invalidateCatalog("test-seed");
}

describe("grants and roles", () => {
  it("creates roles and links keys", async () => {
    const { createRole, listRoles, updateRole } = await import("../lib/auth/grants");
    const { createKey } = await import("../lib/auth/keys");
    const role = createRole({ name: "dev-wegrow" });
    const key = createKey({ name: "k1" });
    updateRole(role.id, { keyIds: [key.id] });
    const roles = listRoles();
    expect(roles).toHaveLength(1);
    expect(roles[0].keyIds).toEqual([key.id]);
  });

  it("upserts a grant and its tool selection", async () => {
    await seed();
    const { upsertGrant, grantFor } = await import("../lib/auth/grants");
    const { createKey } = await import("../lib/auth/keys");
    const key = createKey({ name: "sk-aaa" });

    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "selected", tools: ["A", "B", "C"] });
    let g = grantFor("key", key.id, "u1");
    expect(g?.toolMode).toBe("selected");
    expect(g?.tools.sort()).toEqual(["A", "B", "C"]);

    // Upsert replaces the tool selection.
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "selected", tools: ["B"] });
    g = grantFor("key", key.id, "u1");
    expect(g?.tools).toEqual(["B"]);
  });

  it("computes effective access end to end for the spec scenario (sk-aaa vs sk-bbb)", async () => {
    await seed();
    const { upsertGrant, effectiveAccessForKey } = await import("../lib/auth/grants");
    const { createKey } = await import("../lib/auth/keys");

    const aaa = createKey({ name: "agent-a" });
    const bbb = createKey({ name: "agent-b" });
    upsertGrant({ subjectType: "key", subjectId: aaa.id, upstreamId: "u1", toolMode: "selected", tools: ["A", "B", "C"] });
    upsertGrant({ subjectType: "key", subjectId: bbb.id, upstreamId: "u1", toolMode: "selected", tools: ["B"] });

    const a = effectiveAccessForKey(aaa.id)!;
    const b = effectiveAccessForKey(bbb.id)!;
    expect(a.upstreams.u1.tools).toEqual(["A", "B", "C"]);
    expect(a.publicTools.sort()).toEqual(["toto__A", "toto__B", "toto__C"]);
    expect(b.upstreams.u1.tools).toEqual(["B"]);
    expect(b.publicTools).toEqual(["toto__B"]);
  });

  it("role grant in all mode + key deny removes one tool", async () => {
    await seed();
    const { createRole, upsertGrant, effectiveAccessForKey, setKeyDenies, updateRole } = await import("../lib/auth/grants");
    const { createKey } = await import("../lib/auth/keys");
    const role = createRole({ name: "dev" });
    upsertGrant({ subjectType: "role", subjectId: role.id, upstreamId: "u1", toolMode: "all" });
    const key = createKey({ name: "sk-ccc", roleIds: [role.id] });
    setKeyDenies(key.id, [{ upstreamId: "u1", toolName: "C" }]);

    const acc = effectiveAccessForKey(key.id)!;
    expect(acc.upstreams.u1.tools).toEqual(["A", "B", "D"]);
    expect(acc.upstreams.u1.removedByDeny).toEqual(["C"]);
  });

  it("a key deny on the whole upstream removes access", async () => {
    await seed();
    const { upsertGrant, effectiveAccessForKey, setKeyDenies } = await import("../lib/auth/grants");
    const { createKey } = await import("../lib/auth/keys");
    const key = createKey({ name: "k" });
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "all" });
    setKeyDenies(key.id, [{ upstreamId: "u1", toolName: null }]);
    expect(effectiveAccessForKey(key.id)!.publicTools).toEqual([]);
  });

  it("global override disabling a tool hides it for every key", async () => {
    await seed();
    const { upsertGrant, effectiveAccessForKey } = await import("../lib/auth/grants");
    const { setOverride } = await import("../lib/catalog/overrides");
    const { createKey } = await import("../lib/auth/keys");
    const key = createKey({ name: "k" });
    upsertGrant({ subjectType: "key", subjectId: key.id, upstreamId: "u1", toolMode: "all" });
    setOverride("u1", "tool", "B", { enabled: false });
    const { invalidateCatalog } = await import("../lib/catalog/catalog");
    invalidateCatalog("test");
    const acc = effectiveAccessForKey(key.id)!;
    expect(acc.upstreams.u1.tools).toEqual(["A", "C", "D"]);
  });

  it("access matrix summarises all and selected modes", async () => {
    await seed();
    const { upsertGrant, accessMatrix } = await import("../lib/auth/grants");
    const { createKey } = await import("../lib/auth/keys");
    const k1 = createKey({ name: "k1" });
    const k2 = createKey({ name: "k2" });
    upsertGrant({ subjectType: "key", subjectId: k1.id, upstreamId: "u1", toolMode: "all" });
    upsertGrant({ subjectType: "key", subjectId: k2.id, upstreamId: "u1", toolMode: "selected", tools: ["A", "B"] });
    const m = accessMatrix();
    const row1 = m.rows.find((r) => r.subjectId === k1.id)!;
    const row2 = m.rows.find((r) => r.subjectId === k2.id)!;
    expect(row1.cells.u1.kind).toBe("all");
    expect(row1.cells.u1.selected).toBe(4);
    expect(row2.cells.u1.kind).toBe("selected");
    expect(row2.cells.u1.selected).toBe(2);
    expect(m.upstreams[0].toolCount).toBe(4);
  });

  it("deleting a role removes its grants", async () => {
    await seed();
    const { createRole, upsertGrant, deleteRole, listRoles, accessForUpstream } = await import("../lib/auth/grants");
    const role = createRole({ name: "temp" });
    upsertGrant({ subjectType: "role", subjectId: role.id, upstreamId: "u1", toolMode: "all", tools: [] });
    expect(accessForUpstream("u1")).toHaveLength(1);
    deleteRole(role.id);
    expect(listRoles()).toHaveLength(0);
    expect(accessForUpstream("u1")).toHaveLength(0);
  });
});
