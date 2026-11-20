import { guardResponse, json, notFound, requireAdmin, unavailable } from "@/lib/api/guard";
import { safeManager } from "@/lib/api/upstreams";
import { upstreamById } from "@/lib/api/serialize";
import { logEvent } from "@/lib/logs";

/**
 * POST /api/v1/upstreams/{id}/oauth/start   (spec §4.2 step 3)
 *   -> { authorizationUrl: string }
 *   The admin opens that URL in a browser; the provider redirects to /oauth/callback,
 *   which calls manager.completeOAuth() and bounces back to /servers/{id}?oauth=ok|error.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  const row = upstreamById(id);
  if (!row) return notFound("Upstream not found");
  if (row.authType !== "oauth") {
    return json({ error: "This upstream is not configured for OAuth" }, { status: 400 });
  }
  const manager = safeManager();
  if (!manager) return unavailable("Upstream manager is not running");

  try {
    const { authorizationUrl } = await manager.startOAuth(id);
    logEvent({ actor: guard.actor, type: "upstream.oauth_started", message: "OAuth flow started", upstreamId: id, data: { id } });
    return json({ authorizationUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not start the OAuth flow";
    logEvent({ actor: guard.actor, type: "upstream.oauth_start_failed", message, upstreamId: id, data: { id } });
    return json({ error: message }, { status: 502 });
  }
}
