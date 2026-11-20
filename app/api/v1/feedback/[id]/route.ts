import { z } from "zod";
import { guardResponse, json, notFound, parseBody, requireAdmin } from "@/lib/api/guard";
import { FEEDBACK_STATUSES, getFeedback, updateFeedback } from "@/lib/feedback";

/**
 * GET /api/v1/feedback/{id}
 *   -> { feedback, relatedCall, recentCalls }
 *
 * PATCH /api/v1/feedback/{id}   body: { status?, adminNote? }
 *   -> { feedback }
 *
 * Spec §9 + §8 "Fiche d'un retour": the detail carries the linked call (with its args/error
 * previews) and the other recent calls of the same session.
 */
type Ctx = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    status: z.enum(FEEDBACK_STATUSES).optional(),
    adminNote: z.string().max(4000).nullable().optional(),
  })
  .refine((value) => value.status !== undefined || value.adminNote !== undefined, {
    message: "At least one of status, adminNote is required",
  });

export async function GET(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  const detail = getFeedback(id);
  if (!detail) return notFound("Feedback not found");
  return json({
    feedback: {
      ...detail,
      relatedCall: undefined,
      recentCalls: undefined,
    },
    relatedCall: detail.relatedCall,
    recentCalls: detail.recentCalls,
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  if (!getFeedback(id)) return notFound("Feedback not found");
  const parsed = await parseBody(req, patchSchema);
  if (!parsed.ok) return parsed.response;
  const updated = updateFeedback(id, parsed.data, guard.actor);
  if (!updated) return notFound("Feedback not found");
  return json({ feedback: updated });
}
