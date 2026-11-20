import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { itemOverrides, upstreamItems } from "@/lib/db/schema";
import { guardResponse, json, notFound, requireAdmin } from "@/lib/api/guard";
import { isItemKind } from "@/lib/api/util";
import { upstreamById } from "@/lib/api/serialize";
import { getCatalogSnapshot } from "@/lib/catalog/catalog";
import type { ItemKind } from "@/lib/types";

/**
 * GET /api/v1/upstreams/{id}/items?kind=tool|prompt|resource|resource_template
 *   -> { items: ItemView[], counts: { tool, prompt, resource, resource_template } }
 *   ItemView = { kind, name, publicName, description, enabled, alias, descriptionOverride,
 *                definition, fetchedAt }
 *   - publicName is the name MCP clients see (`<slug>__<name>`, or the resource URI).
 *   - enabled=false means the item is disabled globally (item_overrides), which wins over grants.
 *   - `counts` is always the full breakdown regardless of the `kind` filter.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  if (!upstreamById(id)) return notFound("Upstream not found");

  const url = new URL(req.url);
  const kindParam = url.searchParams.get("kind");
  if (kindParam && !isItemKind(kindParam)) {
    return json({ error: "Invalid kind: expected tool|prompt|resource|resource_template" }, { status: 400 });
  }

  const db = getDb();
  const rows = db.select().from(upstreamItems).where(eq(upstreamItems.upstreamId, id)).all();
  const overrides = db.select().from(itemOverrides).where(eq(itemOverrides.upstreamId, id)).all();
  const overrideMap = new Map(overrides.map((o) => [`${o.kind}|${o.name}`, o]));
  const snapshot = getCatalogSnapshot();
  const view = snapshot.upstreams[id];

  const counts = { tool: 0, prompt: 0, resource: 0, resource_template: 0 } as Record<ItemKind, number>;
  const items = [];
  for (const row of rows) {
    counts[row.kind] += 1;
    if (kindParam && row.kind !== kindParam) continue;
    const override = overrideMap.get(`${row.kind}|${row.name}`);
    const definition = (row.definition ?? {}) as Record<string, unknown>;
    let publicName = row.name;
    if (row.kind === "tool") publicName = view?.toolPublicNames.get(row.name) ?? row.name;
    else if (row.kind === "prompt") publicName = view?.promptPublicNames.get(row.name) ?? row.name;
    else if (row.kind === "resource") publicName = view?.resourcePublicUris.get(row.name) ?? row.name;
    else publicName = (definition.uriTemplate as string | undefined) ?? row.name;

    items.push({
      kind: row.kind,
      name: row.name,
      publicName,
      description: override?.descriptionOverride ?? (definition.description as string | undefined) ?? null,
      enabled: override?.enabled ?? true,
      alias: override?.alias ?? null,
      descriptionOverride: override?.descriptionOverride ?? null,
      definition,
      fetchedAt: row.fetchedAt,
    });
  }
  items.sort((a, b) => a.publicName.localeCompare(b.publicName));
  return json({ items, counts });
}
