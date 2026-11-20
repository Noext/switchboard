import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { itemOverrides, upstreamItems } from "@/lib/db/schema";
import { badRequest, guardResponse, json, notFound, parseBody, requireAdmin } from "@/lib/api/guard";
import { decodeParam, isItemKind } from "@/lib/api/util";
import { overrideSchema } from "@/lib/api/schemas";
import { upstreamById } from "@/lib/api/serialize";
import { emitUiEvent } from "@/lib/events";
import { logEvent } from "@/lib/logs";
import { setOverride, resetOverride } from "@/lib/catalog/overrides";
import { invalidateCatalog, getCatalogSnapshot } from "@/lib/catalog/catalog";

/**
 * PUT /api/v1/upstreams/{id}/items/{kind}/{name}   body: { enabled?, alias?, descriptionOverride? }
 *   -> { item: ItemView }     kind = tool|prompt|resource|resource_template; `name` is the
 *   ORIGINAL upstream name (URI for resources), URL-encoded by the client.
 *
 * DELETE /api/v1/upstreams/{id}/items/{kind}/{name}
 *   -> { reset: true }        removes the override (back to the upstream's own definition).
 *
 * A global disable (enabled:false) wins over every grant (spec §7.3).
 */
type Ctx = { params: Promise<{ id: string; kind: string; name: string }> };

function itemView(upstreamId: string, kind: string, name: string) {
  const db = getDb();
  const row = db
    .select()
    .from(upstreamItems)
    .where(and(eq(upstreamItems.upstreamId, upstreamId), eq(upstreamItems.kind, kind as never), eq(upstreamItems.name, name)))
    .get();
  const override = db
    .select()
    .from(itemOverrides)
    .where(and(eq(itemOverrides.upstreamId, upstreamId), eq(itemOverrides.kind, kind as never), eq(itemOverrides.name, name)))
    .get();
  const view = getCatalogSnapshot().upstreams[upstreamId];
  const definition = (row?.definition ?? {}) as Record<string, unknown>;
  let publicName = name;
  if (kind === "tool") publicName = view?.toolPublicNames.get(name) ?? name;
  else if (kind === "prompt") publicName = view?.promptPublicNames.get(name) ?? name;
  else if (kind === "resource") publicName = view?.resourcePublicUris.get(name) ?? name;
  else publicName = (definition.uriTemplate as string | undefined) ?? name;
  return {
    kind,
    name,
    publicName,
    description: override?.descriptionOverride ?? (definition.description as string | undefined) ?? null,
    enabled: override?.enabled ?? true,
    alias: override?.alias ?? null,
    descriptionOverride: override?.descriptionOverride ?? null,
    definition,
    fetchedAt: row?.fetchedAt ?? null,
  };
}

export async function PUT(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const params = await ctx.params;
  const id = params.id;
  const kind = params.kind;
  const name = decodeParam(params.name);

  if (!isItemKind(kind)) return badRequest("Invalid kind: expected tool|prompt|resource|resource_template");
  if (!upstreamById(id)) return notFound("Upstream not found");

  const db = getDb();
  const exists = db
    .select({ name: upstreamItems.name })
    .from(upstreamItems)
    .where(and(eq(upstreamItems.upstreamId, id), eq(upstreamItems.kind, kind), eq(upstreamItems.name, name)))
    .get();
  if (!exists) return notFound("Item not found on this upstream");

  const parsed = await parseBody(req, overrideSchema);
  if (!parsed.ok) return parsed.response;

  setOverride(id, kind, name, {
    enabled: parsed.data.enabled,
    alias: parsed.data.alias,
    descriptionOverride: parsed.data.descriptionOverride,
  });
  invalidateCatalog("override");
  logEvent({
    actor: guard.actor,
    type: "item.override_updated",
    message: `Override updated on ${kind} "${name}"`,
    upstreamId: id,
    data: { id, kind, name, patch: parsed.data },
  });
  emitUiEvent("upstream.items", { upstreamId: id, kind, name });
  emitUiEvent("catalog.changed", { reason: "override", upstreamId: id });
  return json({ item: itemView(id, kind, name) });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const params = await ctx.params;
  const id = params.id;
  const kind = params.kind;
  const name = decodeParam(params.name);
  if (!isItemKind(kind)) return badRequest("Invalid kind: expected tool|prompt|resource|resource_template");
  if (!upstreamById(id)) return notFound("Upstream not found");

  resetOverride(id, kind, name);
  invalidateCatalog("override-reset");
  logEvent({
    actor: guard.actor,
    type: "item.override_reset",
    message: `Override reset on ${kind} "${name}"`,
    upstreamId: id,
    data: { id, kind, name },
  });
  emitUiEvent("upstream.items", { upstreamId: id, kind, name });
  emitUiEvent("catalog.changed", { reason: "override-reset", upstreamId: id });
  return json({ reset: true, item: itemView(id, kind, name) });
}
