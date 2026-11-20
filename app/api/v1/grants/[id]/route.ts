import { deleteGrant } from "@/lib/auth/grants";
import { guardResponse, json, notFound, requireAdmin } from "@/lib/api/guard";
import { getDb } from "@/lib/db";
import { grantTools, grants } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { emitUiEvent } from "@/lib/events";

/**
 * GET /api/v1/grants/{id}
 *   -> { grant: { id, subjectType, subjectId, upstreamId, toolMode, tools[], prompts, resources } }
 *
 * DELETE /api/v1/grants/{id}
 *   -> { deleted: true, id, subjectType, subjectId }
 *   The subject (key or role) immediately loses that MCP.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  const db = getDb();
  const row = db.select().from(grants).where(eq(grants.id, id)).get();
  if (!row) return notFound("Grant not found");
  const tools = db.select().from(grantTools).where(eq(grantTools.grantId, id)).all().map((t) => t.toolName).sort();
  return json({ grant: { ...row, tools } });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  const db = getDb();
  const row = db.select().from(grants).where(eq(grants.id, id)).get();
  if (!row) return notFound("Grant not found");
  deleteGrant(id, guard.actor);
  emitUiEvent("grant.changed", { grantId: id, subjectType: row.subjectType, subjectId: row.subjectId, action: "deleted" });
  if (row.subjectType === "key") emitUiEvent("key.changed", { keyId: row.subjectId, action: "grant-removed" });
  return json({ deleted: true, id, subjectType: row.subjectType, subjectId: row.subjectId });
}
