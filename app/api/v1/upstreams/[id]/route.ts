import { guardResponse, json, notFound, parseBody, requireAdmin } from "@/lib/api/guard";
import { upstreamPatchSchema } from "@/lib/api/schemas";
import { patchUpstream, removeUpstream } from "@/lib/api/upstreams";
import { serializeUpstream, upstreamById } from "@/lib/api/serialize";
import { getDb } from "@/lib/db";
import { grantTools, grants } from "@/lib/db/schema";
import { inArray } from "drizzle-orm";

/**
 * GET /api/v1/upstreams/{id}
 *   -> { upstream: UpstreamView, grants: Array<{ id, subjectType, subjectId, toolMode, tools[], prompts, resources }> }
 *
 * PATCH /api/v1/upstreams/{id}  body: any subset of upstream fields (secrets only when provided)
 *   -> { upstream: UpstreamView }   (secrets are replaced, never echoed)
 *
 * DELETE /api/v1/upstreams/{id}
 *   -> { deleted: true, id }        (also removes items, overrides, grants, denies, discoveries)
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  const row = upstreamById(id);
  if (!row) return notFound("Upstream not found");

  const db = getDb();
  const grantRows = db.select().from(grants).where(inArray(grants.upstreamId, [id])).all();
  const grantIds = grantRows.map((g) => g.id);
  const toolRows = grantIds.length ? db.select().from(grantTools).where(inArray(grantTools.grantId, grantIds)).all() : [];
  const toolsByGrant = new Map<string, string[]>();
  for (const tool of toolRows) {
    const list = toolsByGrant.get(tool.grantId) ?? [];
    list.push(tool.toolName);
    toolsByGrant.set(tool.grantId, list);
  }

  return json({
    upstream: serializeUpstream(row),
    grants: grantRows.map((g) => ({
      id: g.id,
      subjectType: g.subjectType,
      subjectId: g.subjectId,
      toolMode: g.toolMode,
      tools: (toolsByGrant.get(g.id) ?? []).sort(),
      prompts: g.prompts,
      resources: g.resources,
    })),
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  if (!upstreamById(id)) return notFound("Upstream not found");
  const parsed = await parseBody(req, upstreamPatchSchema);
  if (!parsed.ok) return parsed.response;
  const upstream = patchUpstream(id, parsed.data, guard.actor);
  if (!upstream) return notFound("Upstream not found");
  return json({ upstream });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  const deleted = await removeUpstream(id, guard.actor);
  if (!deleted) return notFound("Upstream not found");
  return json({ deleted: true, id });
}
