import { listKeys } from "@/lib/auth/keys";
import { guardResponse, json, parseBody, requireAdmin, conflict } from "@/lib/api/guard";
import { keyCreateSchema } from "@/lib/api/schemas";
import { createKeyWithAccess, serializeKeys } from "@/lib/api/keys";
import { buildInstallPayload } from "@/lib/api/install-payload";
import { emitUiEvent } from "@/lib/events";

/**
 * GET /api/v1/keys
 *   -> { items: KeyView[] }
 *   KeyView = key row (no hash/secret) + status ("active"|"expired"|"revoked"), roleIds, roleNames,
 *   counts { upstreams, tools, prompts, resources, estimatedTokens }, calls
 *   { calls24h, errors24h, denied24h, calls7d, lastCallAt }, sessions[].
 *
 * POST /api/v1/keys   body: { name, description?, scope?, exposureMode?, expiresAt?, roleIds?,
 *                             copyFromKeyId?, grants?: [{upstreamId, toolMode, tools[], prompts, resources}] }
 *   -> 201 { key: KeyView, secret: "sk-sw-…" }   <- THE SECRET IS RETURNED EXACTLY ONCE
 *   Optional `?include=install` also returns { install: { url, markdown, json, command } }.
 */
export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const keys = listKeys();
  return json({ items: serializeKeys(keys) });
}

export async function POST(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const parsed = await parseBody(req, keyCreateSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const created = createKeyWithAccess({ ...parsed.data, actor: guard.actor });
    emitUiEvent("key.changed", { keyId: created.id, action: "created" });
    const detail = serializeKeys(listKeys()).find((k) => k.id === created.id) ?? null;
    const url = new URL(req.url);
    const payload: Record<string, unknown> = { key: detail, secret: created.secret };
    if (url.searchParams.get("include") === "install") {
      payload.install = buildInstallPayload(created.id, created.secret);
    }
    return json(payload, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create key";
    if (/unique|UNIQUE constraint/i.test(message)) return conflict("A key with this name already exists");
    return json({ error: message }, { status: 400 });
  }
}
