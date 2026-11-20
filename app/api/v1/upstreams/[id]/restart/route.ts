import { guardResponse, json, notFound, requireAdmin, unavailable } from "@/lib/api/guard";
import { safeManager } from "@/lib/api/upstreams";
import { serializeUpstream, upstreamById } from "@/lib/api/serialize";
import { emitUiEvent } from "@/lib/events";
import { logEvent } from "@/lib/logs";

/**
 * POST /api/v1/upstreams/{id}/restart
 *   -> { restarted: true, upstream: UpstreamView }
 *   Reconnects this upstream only (spec §4.3) and notifies the UI.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  if (!upstreamById(id)) return notFound("Upstream not found");
  const manager = safeManager();
  if (!manager) return unavailable("Upstream manager is not running");

  try {
    await manager.restart(id);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Restart failed";
    logEvent({ actor: guard.actor, type: "upstream.restart_failed", message, upstreamId: id, data: { id } });
    emitUiEvent("upstream.status", { upstreamId: id });
    return json({ restarted: false, error: message }, { status: 502 });
  }

  logEvent({ actor: guard.actor, type: "upstream.restarted", message: "Upstream restarted", upstreamId: id, data: { id } });
  emitUiEvent("upstream.status", { upstreamId: id });
  const row = upstreamById(id);
  return json({ restarted: true, upstream: row ? serializeUpstream(row) : null });
}
