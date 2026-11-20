import { z } from "zod";
import { badRequest, guardResponse, json, parseBody, requireAdmin } from "@/lib/api/guard";
import { FEEDBACK_STATUSES, bulkUpdateStatus } from "@/lib/feedback";

/**
 * POST /api/v1/feedback/bulk   body: { ids: string[], status }
 *   -> { updated, ids }
 *
 * Spec §9 / §8 "Sélection multiple pour changer le statut en lot".
 */
export const dynamic = "force-dynamic";

const bulkSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(500),
  status: z.enum(FEEDBACK_STATUSES),
});

export async function POST(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const parsed = await parseBody(req, bulkSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const result = bulkUpdateStatus(parsed.data.ids, parsed.data.status, guard.actor);
    if (result.updated === 0) return badRequest("No matching feedback id");
    return json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Bulk update failed";
    return badRequest(message);
  }
}
