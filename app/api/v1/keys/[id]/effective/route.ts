import { getKey } from "@/lib/auth/keys";
import { guardResponse, json, notFound, requireAdmin } from "@/lib/api/guard";
import { buildEffectiveAccessView } from "@/lib/api/access-view";

/**
 * GET /api/v1/keys/{id}/effective   ("Aperçu effectif", spec §8 fiche clé)
 *   -> {
 *        effective: {
 *          keyId, keyName, exposureMode, scope, usable,
 *          upstreams: [{ upstreamId, slug, name, status, hasAccess,
 *                        tools: [{ name, publicName, description }],
 *                        prompts: [...]|null, resources: [...]|null,
 *                        removedByDeny[], disabledGlobally[], sources[] }],
 *          publicTools: string[],           // exactly what the agent will see
 *          totals: { upstreams, tools, prompts, resources, estimatedTokens }
 *        },
 *        upstreamSlugById: Record<upstreamId, slug>
 *      }
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  const key = getKey(id);
  if (!key) return notFound("Key not found");
  const effective = buildEffectiveAccessView(id);
  const upstreamSlugById: Record<string, string> = {};
  for (const upstream of effective?.upstreams ?? []) upstreamSlugById[upstream.upstreamId] = upstream.slug;
  return json({ effective, upstreamSlugById });
}
