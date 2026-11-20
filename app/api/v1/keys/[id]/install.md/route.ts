import { getKey } from "@/lib/auth/keys";
import { guardResponse, notFound, requireAdmin } from "@/lib/api/guard";
import { buildEffectiveAccessView } from "@/lib/api/access-view";
import { buildInstallMarkdown, publicBaseUrl } from "@/lib/api/install";

/**
 * GET /api/v1/keys/{id}/install.md
 *   -> text/markdown (inline by default so the UI can open it in a tab and render it)
 *   Spec §6.4: URL, key placeholder (the secret is only shown once and is NOT in this file),
 *   Claude Code / Codex / JSON snippets, and the exact list of MCPs and tools the key may use.
 *   ?download=1 adds Content-Disposition: attachment; filename="INSTALL-<name>.md".
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  const key = getKey(id);
  if (!key) return notFound("Key not found");
  const view = buildEffectiveAccessView(id);
  if (!view) return notFound("Key not found");
  const markdown = buildInstallMarkdown(key, view);

  const url = new URL(req.url);
  const download = url.searchParams.get("download") === "1" || url.searchParams.get("download") === "true";
  const safeName = key.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const headers = new Headers({
    "content-type": "text/markdown; charset=utf-8",
    "cache-control": "no-store",
    // Public URL is included in the body; expose it for UI convenience.
    "x-switchboard-public-url": publicBaseUrl(),
    "x-switchboard-key-name": key.name,
  });
  if (download) headers.set("content-disposition", `attachment; filename="INSTALL-${safeName}.md"`);
  return new Response(markdown, { status: 200, headers });
}
