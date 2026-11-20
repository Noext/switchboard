import { deleteRole, getRole, updateRole } from "@/lib/auth/grants";
import { guardResponse, json, notFound, parseBody, requireAdmin, conflict } from "@/lib/api/guard";
import { rolePatchSchema } from "@/lib/api/schemas";
import { getDb } from "@/lib/db";
import { grants, grantTools } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { emitUiEvent } from "@/lib/events";
import { keyStatus } from "@/lib/api/keys";
import { getKey } from "@/lib/auth/keys";

/**
 * GET /api/v1/roles/{id}
 *   -> { role: { id, name, description, createdAt, keyIds, keyNames }, grants: [...], keys: [...] }
 *
 * PATCH /api/v1/roles/{id}   body: { name?, description?, keyIds? }
 *   -> { role }
 *   Changing a role updates every key that uses it immediately (spec §7.2).
 *
 * DELETE /api/v1/roles/{id}
 *   -> { deleted: true, id }    also removes its grants and key links.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  const role = getRole(id);
  if (!role) return notFound("Role not found");

  const db = getDb();
  const grantRows = db.select().from(grants).where(and(eq(grants.subjectType, "role"), eq(grants.subjectId, id))).all();
  const toolRows = grantRows.length
    ? db.select().from(grantTools).all().filter((t) => grantRows.some((g) => g.id === t.grantId))
    : [];
  const keys = role.keyIds
    .map((keyId) => {
      const key = getKey(keyId);
      return key ? { id: key.id, name: key.name, scope: key.scope, status: keyStatus(key) } : null;
    })
    .filter((k): k is { id: string; name: string; scope: "agent" | "admin"; status: "active" | "expired" | "revoked" } => k !== null);

  return json({
    role: { ...role, keyNames: keys.map((k) => k.name) },
    grants: grantRows.map((g) => ({
      id: g.id,
      upstreamId: g.upstreamId,
      toolMode: g.toolMode,
      tools: toolRows.filter((t) => t.grantId === g.id).map((t) => t.toolName).sort(),
      prompts: g.prompts,
      resources: g.resources,
    })),
    keys,
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  if (!getRole(id)) return notFound("Role not found");
  const parsed = await parseBody(req, rolePatchSchema);
  if (!parsed.ok) return parsed.response;
  try {
    updateRole(id, parsed.data, guard.actor);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update role";
    if (/unique|UNIQUE constraint/i.test(message)) return conflict("A role with this name already exists");
    return json({ error: message }, { status: 400 });
  }
  emitUiEvent("grant.changed", { roleId: id, action: "updated" });
  return json({ role: getRole(id) });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  if (!getRole(id)) return notFound("Role not found");
  deleteRole(id, guard.actor);
  emitUiEvent("grant.changed", { roleId: id, action: "deleted" });
  return json({ deleted: true, id });
}
