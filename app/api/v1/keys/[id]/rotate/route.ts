import { getKey, rotateKey } from "@/lib/auth/keys";
import { guardResponse, json, notFound, parseBody, requireAdmin } from "@/lib/api/guard";
import { rotateSchema } from "@/lib/api/schemas";
import { keyDetail } from "@/lib/api/keys";
import { buildInstallPayload } from "@/lib/api/install-payload";
import { emitUiEvent } from "@/lib/events";

/**
 * POST /api/v1/keys/{id}/rotate   body: { graceSeconds: 0 | 3600 | 86400 }   (default 0)
 *   -> { key: KeyView, secret: "sk-sw-…", graceSeconds, install?: InstallPayload }
 *   The new secret is shown once. With graceSeconds > 0 the previous secret keeps working
 *   until it expires (spec §7.1). Same rights, nothing else changes.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  if (!getKey(id)) return notFound("Key not found");
  const parsed = await parseBody(req, rotateSchema);
  if (!parsed.ok) return parsed.response;

  const { secret } = rotateKey(id, parsed.data.graceSeconds, guard.actor);
  emitUiEvent("key.changed", { keyId: id, action: "rotated", graceSeconds: parsed.data.graceSeconds });
  const detail = keyDetail(id);
  const loadInstall = new URL(req.url).searchParams.get("include") === "install";
  return json({
    key: detail?.key ?? null,
    secret,
    graceSeconds: parsed.data.graceSeconds,
    ...(loadInstall ? { install: buildInstallPayload(id, secret) } : {}),
  });
}
