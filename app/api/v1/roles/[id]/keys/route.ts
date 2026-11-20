import { getRole, updateRole } from "@/lib/auth/grants";
import { guardResponse, json, notFound, parseBody, requireAdmin } from "@/lib/api/guard";
import { roleKeysSchema } from "@/lib/api/schemas";
import { emitUiEvent } from "@/lib/events";

/**
 * PUT /api/v1/roles/{id}/keys   body: { keyIds: string[] }
 *   -> { role: { id, keyIds }, updated: number }
 *   REPLACES the set of keys using this role (spec §9 "PUT /roles/{id}/keys").
 *   Every affected key gets an immediate list_changed in the running gateway.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  if (!getRole(id)) return notFound("Role not found");
  const parsed = await parseBody(req, roleKeysSchema);
  if (!parsed.ok) return parsed.response;
  updateRole(id, { keyIds: parsed.data.keyIds }, guard.actor);
  emitUiEvent("grant.changed", { roleId: id, action: "keys", keyIds: parsed.data.keyIds });
  return json({ role: { id, keyIds: parsed.data.keyIds }, updated: parsed.data.keyIds.length });
}
