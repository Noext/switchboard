import { guardResponse, json, requireAdmin } from "@/lib/api/guard";
import { boolParam } from "@/lib/api/util";
import { listDiscoveries, pendingDiscoveryCount } from "./_lib";

/**
 * GET /api/v1/discoveries?includeAcknowledged=&upstreamId=
 *   -> { items, total, pending }
 *
 * Spec §9 / §7.4: new tools published by an upstream, with the subjects that already have them
 * (mode `all`) and those that still need a decision (mode `selected`).
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);

  const url = new URL(req.url);
  const includeAcknowledged = boolParam(url, "includeAcknowledged") ?? false;
  const upstreamId = url.searchParams.get("upstreamId") ?? undefined;

  const items = listDiscoveries({ includeAcknowledged, upstreamId });
  return json({
    items,
    total: items.length,
    /** Unacknowledged count across all upstreams, for the dashboard badge. */
    pending: pendingDiscoveryCount(),
  });
}
