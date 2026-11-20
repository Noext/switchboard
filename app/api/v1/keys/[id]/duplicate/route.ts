import { duplicateKey, getKey, listKeys } from "@/lib/auth/keys";
import { guardResponse, json, notFound, parseBody, requireAdmin, conflict } from "@/lib/api/guard";
import { duplicateSchema } from "@/lib/api/schemas";
import { serializeKeys } from "@/lib/api/keys";
import { buildInstallPayload } from "@/lib/api/install-payload";
import { emitUiEvent } from "@/lib/events";

/**
 * POST /api/v1/keys/{id}/duplicate   body: { name }
 *   -> 201 { key: KeyView, secret: "sk-sw-…", install?: InstallPayload }
 *   Copies roles, own grants and key-level denies (spec §7.1).
 */
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  if (!getKey(id)) return notFound("Key not found");
  const parsed = await parseBody(req, duplicateSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const created = duplicateKey(id, parsed.data.name, guard.actor);
    emitUiEvent("key.changed", { keyId: created.id, action: "duplicated", from: id });
    const view = serializeKeys(listKeys()).find((k) => k.id === created.id) ?? null;
    const loadInstall = new URL(req.url).searchParams.get("include") === "install";
    return json(
      {
        key: view,
        secret: created.secret,
        ...(loadInstall ? { install: buildInstallPayload(created.id, created.secret) } : {}),
      },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to duplicate key";
    if (/unique|UNIQUE constraint/i.test(message)) return conflict("A key with this name already exists");
    return json({ error: message }, { status: 400 });
  }
}
