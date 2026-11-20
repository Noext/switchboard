import { getKey, updateKey } from "@/lib/auth/keys";
import { guardResponse, json, notFound, parseBody, requireAdmin, conflict } from "@/lib/api/guard";
import { keyPatchSchema } from "@/lib/api/schemas";
import { keyDetail } from "@/lib/api/keys";
import { emitUiEvent } from "@/lib/events";

/**
 * GET /api/v1/keys/{id}
 *   -> { key: KeyView, effective: EffectiveAccessView, ownGrants: [...], denies: [...] }
 *   ownGrants = the key's OWN grants (role grants are visible through `effective.sources`).
 *
 * PATCH /api/v1/keys/{id}   body: { name?, description?, exposureMode?, expiresAt?, roleIds? }
 *   -> { key: KeyView, effective }    (roleIds replaces the role set)
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  const detail = keyDetail(id);
  if (!detail) return notFound("Key not found");
  return json(detail);
}

export async function PATCH(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  if (!getKey(id)) return notFound("Key not found");
  const parsed = await parseBody(req, keyPatchSchema);
  if (!parsed.ok) return parsed.response;
  try {
    updateKey(id, parsed.data, guard.actor);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update key";
    if (/unique|UNIQUE constraint/i.test(message)) return conflict("A key with this name already exists");
    return json({ error: message }, { status: 400 });
  }
  emitUiEvent("key.changed", { keyId: id, action: "updated" });
  const detail = keyDetail(id);
  return json({ key: detail?.key ?? null, effective: detail?.effective ?? null });
}
