import { z } from "zod";
import { guardResponse, json, parseBody, requireAdmin } from "@/lib/api/guard";
import { acknowledgeDiscoveries } from "../_lib";

/**
 * POST /api/v1/discoveries/ack
 *   body: { upstreamId, toolName? }        — one discovery, or every discovery of an upstream
 *      or { items: [{ upstreamId, toolName? }] }
 *   -> { acknowledged, items }
 *
 * Spec §7.4 / §9 "ignorer": sets `acknowledgedAt`, which hides the dashboard banner.
 */
export const dynamic = "force-dynamic";

const itemSchema = z.object({
  upstreamId: z.string().min(1),
  toolName: z.string().min(1).nullish(),
});

const ackSchema = z.union([
  itemSchema.extend({ items: z.undefined().optional() }),
  z.object({ items: z.array(itemSchema).min(1).max(500) }),
]);

export async function POST(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const parsed = await parseBody(req, ackSchema);
  if (!parsed.ok) return parsed.response;

  const raw = parsed.data as { upstreamId?: string; toolName?: string | null; items?: Array<{ upstreamId: string; toolName?: string | null }> };
  const items = raw.items ?? (raw.upstreamId ? [{ upstreamId: raw.upstreamId, toolName: raw.toolName ?? null }] : []);
  const result = acknowledgeDiscoveries(items, guard.actor);
  return json(result);
}
