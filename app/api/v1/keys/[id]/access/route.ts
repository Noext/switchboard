import { getKey } from "@/lib/auth/keys";
import { guardResponse, json, notFound, requireAdmin } from "@/lib/api/guard";
import { matrixRowFor, matrixWithGrantIds } from "@/lib/api/matrix";
import { buildEffectiveAccessView } from "@/lib/api/access-view";

/**
 * GET /api/v1/keys/{id}/access
 *   -> {
 *        upstreams: [{ id, slug, name, toolCount }],
 *        row: { subjectType: "key", subjectId, label,
 *               cells: { [upstreamId]: { kind, selected, total, toolNames[], grantId } } },
 *        effective: EffectiveAccessView
 *      }
 *   Same shape as one `rows` entry of /access-matrix, plus the effective preview, so the rights
 *   editor can render the "Aucun accès / Tous / Sélection" selector and resolve grant ids.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  if (!getKey(id)) return notFound("Key not found");
  const matrix = matrixWithGrantIds();
  return json({
    upstreams: matrix.upstreams,
    row: matrixRowFor("key", id),
    effective: buildEffectiveAccessView(id),
  });
}
