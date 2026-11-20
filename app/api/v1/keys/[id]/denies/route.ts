import { getKey } from "@/lib/auth/keys";
import { getKeyDenies, setKeyDenies } from "@/lib/auth/grants";
import { guardResponse, json, notFound, parseBody, requireAdmin } from "@/lib/api/guard";
import { deniesSchema } from "@/lib/api/schemas";
import { buildEffectiveAccessView } from "@/lib/api/access-view";
import { emitUiEvent } from "@/lib/events";

/**
 * GET /api/v1/keys/{id}/denies
 *   -> { denies: [{ upstreamId, toolName: string|null }] }   (toolName null = whole MCP removed)
 *
 * PUT /api/v1/keys/{id}/denies   body: { denies: [{ upstreamId, toolName: string|null }] }
 *   -> { denies: [...], effective }        REPLACES the whole removal list for this key.
 *   A removal always wins over a grant from a role (spec §7.3).
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  if (!getKey(id)) return notFound("Key not found");
  return json({ denies: getKeyDenies(id) });
}

export async function PUT(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  if (!getKey(id)) return notFound("Key not found");
  const parsed = await parseBody(req, deniesSchema);
  if (!parsed.ok) return parsed.response;

  setKeyDenies(id, parsed.data.denies, guard.actor);
  emitUiEvent("grant.changed", { keyId: id, action: "denies" });
  emitUiEvent("key.changed", { keyId: id, action: "denies" });
  return json({ denies: getKeyDenies(id), effective: buildEffectiveAccessView(id) });
}
