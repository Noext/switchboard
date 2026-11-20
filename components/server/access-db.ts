import "server-only";
import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { apiKeys, grants, grantTools, itemOverrides, keyDenies, keyRoles, roles, upstreamItems, upstreams } from "@/lib/db/schema";
import { getKeyDenies } from "@/lib/auth/grants";
import {
  accessCatalog,
  applicableGrants,
  buildMatrixRows,
  computeAccessFor,
  type MatrixRow,
} from "@/components/access-view";
import { buildCatalogView } from "@/components/catalog-view";
import type { EffectiveAccess } from "@/lib/types";

/**
 * DB-backed effective-access read models for the admin UI.
 *
 * Why not `effectiveAccessForKey()` / `accessMatrix()`? They read the cached catalog snapshot;
 * these read the tables, so a server-component render always reflects the current truth (an
 * upstream just added, a grant just changed). Both routes run the same pure
 * `computeEffectiveAccess`; tests/ui-access-parity.test.ts proves they agree.
 */

function catalogRows() {
  const db = getDb();
  return {
    upstreams: db.select().from(upstreams).all(),
    items: db.select().from(upstreamItems).all(),
    overrides: db.select().from(itemOverrides).all(),
  };
}

/** Fresh effective access for one key. */
export function effectiveAccessDb(keyId: string, now = Date.now()): EffectiveAccess | null {
  const db = getDb();
  const key = db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).get();
  if (!key) return null;
  const roleIds = db.select().from(keyRoles).where(eq(keyRoles.keyId, keyId)).all().map((r) => r.roleId);
  const rows = catalogRows();

  return computeAccessFor({
    key: { id: key.id, scope: key.scope, revokedAt: key.revokedAt, expiresAt: key.expiresAt },
    roleIds,
    grants: applicableGrants({
      keyId,
      roleIds,
      grants: db.select().from(grants).all(),
      grantTools: db.select().from(grantTools).all(),
      roleNames: db.select({ id: roles.id, name: roles.name }).from(roles).all(),
      keyNames: db.select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys).all(),
    }),
    denies: getKeyDenies(keyId) as Array<{ upstreamId: string; toolName: string | null }>,
    catalog: accessCatalog(rows.upstreams, rows.items, rows.overrides).catalog,
    now,
  });
}

export type { MatrixCell, MatrixRow } from "@/components/access-view";

export interface MatrixData {
  upstreams: Array<{ id: string; slug: string; name: string; toolCount: number }>;
  rows: MatrixRow[];
}

/** Access matrix (rows = keys + roles, columns = upstreams) read from the tables. */
export function accessMatrixDb(): MatrixData {
  const db = getDb();
  const rows = catalogRows();
  const view = buildCatalogView(rows.upstreams, rows.items, rows.overrides);

  const upstreamList = db
    .select({ id: upstreams.id, slug: upstreams.slug, name: upstreams.name })
    .from(upstreams)
    .all()
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const toolCount = new Map(view.map((u) => [u.id, u.tools.length] as const));

  return {
    upstreams: upstreamList.map((u) => ({ id: u.id, slug: u.slug, name: u.name, toolCount: toolCount.get(u.id) ?? 0 })),
    rows: buildMatrixRows({
      upstreams: upstreamList.map((u) => ({ id: u.id, slug: u.slug, name: u.name, toolCount: toolCount.get(u.id) ?? 0 })),
      keys: db.select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys).all(),
      roles: db.select({ id: roles.id, name: roles.name }).from(roles).all(),
      grants: db.select().from(grants).all(),
      grantTools: db.select().from(grantTools).all(),
    }),
  };
}

void keyDenies;
