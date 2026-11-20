import { getDb } from "@/lib/db";
import { apiKeys } from "@/lib/db/schema";
import { guardResponse, json, notFound, requireAdmin } from "@/lib/api/guard";
import { accessForUpstream } from "@/lib/auth/grants";
import { accessForUpstreamDetailed } from "@/lib/api/access-view";
import { serializeUpstream, upstreamById } from "@/lib/api/serialize";

/**
 * GET /api/v1/upstreams/{id}/access   ("qui a accès à ce MCP", spec §8 fiche serveur > Accès)
 *   -> {
 *        upstream: { id, slug, name, status },
 *        grants:  [{ grantId, subjectType: "role"|"key", subjectId, label, toolMode, tools[], prompts, resources }],
 *        keys:    [{ subjectId, label, status, viaRoles[], tools[], prompts, resources, removedByDeny[] }],
 *        roles:   [{ subjectId, label, toolMode, tools[], prompts, resources, keyCount }],
 *        uncovered: string[]   // keys with no access at all
 *      }
 *   `keys` is computed through the effective-access algorithm (so role inheritance and
 *   key-level removals are already applied); `grants` is the raw grant table.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  const row = upstreamById(id);
  if (!row) return notFound("Upstream not found");

  const rawGrants = accessForUpstream(id);
  const keys = accessForUpstreamDetailed(id);

  const db = getDb();
  const allKeys = db.select().from(apiKeys).all();
  const withAccess = new Set(keys.map((k) => k.subjectId));
  const uncovered = allKeys
    .filter((k) => !withAccess.has(k.id) && k.scope === "agent")
    .map((k) => k.name)
    .sort();

  const rolesWithAccess = new Set(rawGrants.filter((g) => g.subjectType === "role").map((g) => g.subjectId));
  const roles = rawGrants
    .filter((g) => g.subjectType === "role")
    .map((g) => ({
      subjectId: g.subjectId,
      label: g.label,
      toolMode: g.toolMode,
      tools: g.tools,
      prompts: g.prompts,
      resources: g.resources,
      keyCount: keys.filter((k) => k.viaRoles.includes(g.label)).length,
    }));

  return json({
    upstream: { id: row.id, slug: row.slug, name: row.name, status: row.status },
    upstreamDetail: serializeUpstream(row),
    grants: rawGrants,
    keys,
    roles,
    uncovered,
    summary: {
      keyCount: keys.length,
      roleCount: rolesWithAccess.size,
      keysViaRole: keys.filter((k) => k.viaRoles.length > 0).length,
    },
  });
}
