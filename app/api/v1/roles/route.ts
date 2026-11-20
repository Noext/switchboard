import { createRole, listRoles } from "@/lib/auth/grants";
import { guardResponse, json, parseBody, requireAdmin, conflict } from "@/lib/api/guard";
import { roleCreateSchema } from "@/lib/api/schemas";
import { getDb } from "@/lib/db";
import { keyRoles } from "@/lib/db/schema";
import { emitUiEvent } from "@/lib/events";

/**
 * GET /api/v1/roles
 *   -> { items: [{ id, name, description, createdAt, keyIds[], keyNames[], upstreamCount, toolsGranted }] }
 *
 * POST /api/v1/roles   body: { name, description?, keyIds?[] }
 *   -> 201 { role }
 */
export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const roles = listRoles();
  const { accessMatrix } = await import("@/lib/auth/grants");
  const matrix = accessMatrix();
  const items = roles.map((role) => {
    const row = matrix.rows.find((r) => r.subjectType === "role" && r.subjectId === role.id);
    const upstreamCount = row ? Object.values(row.cells).filter((c) => c.kind !== "none").length : 0;
    const toolsGranted = row
      ? Object.values(row.cells).reduce((acc, cell) => acc + (cell.kind === "all" ? cell.total : cell.selected), 0)
      : 0;
    return { ...role, upstreamCount, toolsGranted };
  });
  return json({ items });
}

export async function POST(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const parsed = await parseBody(req, roleCreateSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const role = createRole({ name: parsed.data.name, description: parsed.data.description ?? null, actor: guard.actor });
    if (parsed.data.keyIds.length) {
      const db = getDb();
      for (const keyId of parsed.data.keyIds) {
        db.insert(keyRoles).values({ keyId, roleId: role.id }).onConflictDoNothing().run();
      }
    }
    emitUiEvent("grant.changed", { roleId: role.id, action: "created" });
    return json({ role: { ...role, keyIds: parsed.data.keyIds } }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create role";
    if (/unique|UNIQUE constraint/i.test(message)) return conflict("A role with this name already exists");
    return json({ error: message }, { status: 400 });
  }
}
