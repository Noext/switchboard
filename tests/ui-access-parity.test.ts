import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import path from "node:path";

/**
 * Parity guard for the UI's effective-access read model (components/server/access-db.ts).
 *
 * The "Droits" and "Aperçu effectif" tabs must show exactly what the gateway would serve for a
 * key: same upstreams, same tools, same prompts/resources. Both sides run the same pure
 * algorithm (computeEffectiveAccess); this test proves they are fed equivalent input, so a
 * change to grant handling cannot make the UI lie.
 */

process.env.SWITCHBOARD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sb-access-parity-"));
process.env.SWITCHBOARD_SECRET = "0123456789abcdef0123456789abcdef";
process.env.SWITCHBOARD_ADMIN_PASSWORD = "test";

type Mods = {
  db: typeof import("../lib/db");
  schema: typeof import("../lib/db/schema");
  keys: typeof import("../lib/auth/keys");
  grants: typeof import("../lib/auth/grants");
  overrides: typeof import("../lib/catalog/overrides");
  accessDb: typeof import("../components/access-view");
  view: typeof import("../components/catalog-view");
};

let m: Mods;

beforeAll(async () => {
  m = {
    db: await import("../lib/db"),
    schema: await import("../lib/db/schema"),
    keys: await import("../lib/auth/keys"),
    grants: await import("../lib/auth/grants"),
    overrides: await import("../lib/catalog/overrides"),
    accessDb: await import("../components/access-view"),
    view: await import("../components/catalog-view"),
  };
});

function seedUpstream(slug: string, tools: string[], status: "ready" | "connecting" = "ready"): string {
  const handle = m.db.getDb();
  const id = randomUUID();
  const now = Date.now();
  handle
    .insert(m.schema.upstreams)
    .values({
      id,
      slug,
      name: slug.toUpperCase(),
      transport: "http",
      url: "https://" + slug + ".example/mcp",
      authType: "none",
      enabled: true,
      startMode: "always",
      status,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  for (const tool of tools) {
    handle
      .insert(m.schema.upstreamItems)
      .values({ upstreamId: id, kind: "tool", name: tool, definition: { name: tool } as never, fetchedAt: now })
      .run();
  }
  return id;
}

function publicNames(access: { publicTools: string[] } | null): string[] {
  return (access?.publicTools ?? []).slice().sort();
}

/** Mirrors components/server/access-db.ts: read the tables, then run the pure helpers. */
function uiAccess(keyId: string) {
  const handle = m.db.getDb();
  const s = m.schema;
  const key = handle.select().from(s.apiKeys).where(eq(s.apiKeys.id, keyId)).get();
  if (!key) return null;
  const roleIds = handle.select().from(s.keyRoles).where(eq(s.keyRoles.keyId, keyId)).all().map((r) => r.roleId);
  const rows = {
    upstreams: handle.select().from(s.upstreams).all(),
    items: handle.select().from(s.upstreamItems).all(),
    overrides: handle.select().from(s.itemOverrides).all(),
  };
  return m.accessDb.computeAccessFor({
    key: { id: key.id, scope: key.scope, revokedAt: key.revokedAt, expiresAt: key.expiresAt },
    roleIds,
    grants: m.accessDb.applicableGrants({
      keyId,
      roleIds,
      grants: handle.select().from(s.grants).all(),
      grantTools: handle.select().from(s.grantTools).all(),
      roleNames: handle.select({ id: s.roles.id, name: s.roles.name }).from(s.roles).all(),
      keyNames: handle.select({ id: s.apiKeys.id, name: s.apiKeys.name }).from(s.apiKeys).all(),
    }),
    denies: m.grants.getKeyDenies(keyId) as Array<{ upstreamId: string; toolName: string | null }>,
    catalog: m.accessDb.accessCatalog(rows.upstreams, rows.items, rows.overrides).catalog,
  });
}

describe("UI effective access matches lib/auth/grants", () => {
  it("agrees for the spec scenario: selected tools, a role in 'all', and a key-level deny", () => {
    const toto = seedUpstream("toto", ["A", "B", "C", "D"]);

    // Role grants every tool of toto (including future ones).
    const role = m.grants.createRole({ name: "dev" });
    m.grants.upsertGrant({
      subjectType: "role",
      subjectId: role.id,
      upstreamId: toto,
      toolMode: "all",
      prompts: false,
      resources: false,
    });

    // sk-aaa: own grant, selected = A, B, C.
    const aaa = m.keys.createKey({ name: "sk-aaa" });
    m.grants.upsertGrant({
      subjectType: "key",
      subjectId: aaa.id,
      upstreamId: toto,
      toolMode: "selected",
      tools: ["A", "B", "C"],
      prompts: false,
      resources: false,
    });

    // sk-ccc: the role, minus tool C, removed at the key level.
    const ccc = m.keys.createKey({ name: "sk-ccc", roleIds: [role.id] });
    m.grants.setKeyDenies(ccc.id, [{ upstreamId: toto, toolName: "C" }]);

    for (const id of [aaa.id, ccc.id]) {
      const lib = m.grants.effectiveAccessForKey(id);
      const ui = uiAccess(id);
      expect(publicNames(ui)).toEqual(publicNames(lib));

      const libTools = lib?.upstreams[toto]?.tools.slice().sort() ?? [];
      const uiTools = ui?.upstreams[toto]?.tools.slice().sort() ?? [];
      expect(uiTools).toEqual(libTools);
    }

    // Concrete expectations from spec §7.3, so a silent change on BOTH sides still fails.
    expect(publicNames(uiAccess(aaa.id))).toEqual(["toto__A", "toto__B", "toto__C"]);
    expect(publicNames(uiAccess(ccc.id))).toEqual(["toto__A", "toto__B", "toto__D"]);
  });

  it("agrees when a tool is disabled globally and when an upstream is not ready", () => {
    const gh = seedUpstream("gh2", ["x", "y"]);
    const down = seedUpstream("down2", ["z"], "connecting");

    const key = m.keys.createKey({ name: "k-global" });
    for (const upstreamId of [gh, down]) {
      m.grants.upsertGrant({
        subjectType: "key",
        subjectId: key.id,
        upstreamId,
        toolMode: "all",
        prompts: false,
        resources: false,
      });
    }
    m.overrides.setOverride(gh, "tool", "x", { enabled: false });

    const lib = m.grants.effectiveAccessForKey(key.id);
    const ui = uiAccess(key.id);
    expect(publicNames(ui)).toEqual(publicNames(lib));

    // The globally disabled tool is gone everywhere; the non-ready upstream exposes nothing.
    expect(publicNames(ui)).toEqual(["gh2__y"]);
    expect(ui?.upstreams[down]?.tools ?? []).toEqual([]);
  });
});