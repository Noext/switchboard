import "server-only";
import { getDb } from "@/lib/db";
import { itemOverrides, upstreamItems, upstreams } from "@/lib/db/schema";
import { buildCatalogView, type DbCatalogUpstream } from "@/components/catalog-view";

/**
 * DB-derived catalog for the admin UI.
 *
 * Why not `getCatalogSnapshot()`? It is a process-local, event-invalidated cache. Reading the
 * tables below is cheap (a few hundred rows) and is the source of truth, so a server component
 * renders the catalog as it is right now regardless of which module graph invalidated what.
 * The naming rules live in components/catalog-view.ts (pure) and are parity-tested against
 * lib/catalog/catalog.ts by tests/ui-catalog-parity.test.ts.
 */

export type { DbCatalogItem, DbCatalogTool, DbCatalogUpstream } from "@/components/catalog-view";

export function catalogFromDb(): DbCatalogUpstream[] {
  const db = getDb();
  return buildCatalogView(
    db.select().from(upstreams).all(),
    db.select().from(upstreamItems).all(),
    db.select().from(itemOverrides).all(),
  );
}

/** Slug/tool counters per upstream, for dashboard-style tables. */
export function toolSummaryFromDb(): Map<string, { slug: string; toolCount: number; publicNames: string[] }> {
  const out = new Map<string, { slug: string; toolCount: number; publicNames: string[] }>();
  for (const upstream of catalogFromDb()) {
    out.set(upstream.id, {
      slug: upstream.slug,
      toolCount: upstream.tools.length,
      publicNames: upstream.tools.map((t) => t.publicName),
    });
  }
  return out;
}
