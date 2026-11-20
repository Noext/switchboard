import { getKey, revokeKey } from "@/lib/auth/keys";
import { guardResponse, json, notFound, requireAdmin } from "@/lib/api/guard";
import { keyDetail } from "@/lib/api/keys";
import { emitUiEvent } from "@/lib/events";
import { logEvent } from "@/lib/logs";

/**
 * POST /api/v1/keys/{id}/revoke
 *   -> { revoked: true, key: KeyView }
 *   Revocation takes effect immediately: the key cache is cleared and open MCP sessions of that
 *   key must be closed by the gateway (see the note in the final report).
 */
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  if (!getKey(id)) return notFound("Key not found");
  revokeKey(id, guard.actor);
  logEvent({ actor: guard.actor, type: "key.revoked", message: "Key revoked from the API", data: { id } });
  emitUiEvent("key.changed", { keyId: id, action: "revoked" });
  emitUiEvent("session.changed", { keyId: id, action: "revoked" });
  return json({ revoked: true, key: keyDetail(id)?.key ?? null });
}
