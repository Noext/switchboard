import { z } from "zod";
import { badRequest, guardResponse, json, notFound, parseBody, requireAdmin } from "@/lib/api/guard";
import { getDb } from "@/lib/db";
import { toolDiscoveries, upstreams } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { grantToolToSubjects } from "../_lib";

/**
 * POST /api/v1/discoveries/grant   body: { upstreamId, toolName, subjects: [{subjectType, subjectId}] }
 *   -> { upstreamId, toolName, granted: [...], skipped: [...] }
 *
 * Spec §9 / §7.4 "accorder à…": adds the tool to each subject's grant. A subject in `all` mode
 * already has every tool (skipped); a `selected` grant gets the tool appended; a subject with no
 * grant gets a new `selected` grant holding just that tool.
 */
export const dynamic = "force-dynamic";

const grantSchema = z.object({
  upstreamId: z.string().min(1),
  toolName: z.string().min(1),
  subjects: z
    .array(
      z.object({
        subjectType: z.enum(["role", "key"]),
        subjectId: z.string().min(1),
      }),
    )
    .min(1)
    .max(200),
});

export async function POST(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const parsed = await parseBody(req, grantSchema);
  if (!parsed.ok) return parsed.response;

  const db = getDb();
  const upstream = db.select().from(upstreams).where(eq(upstreams.id, parsed.data.upstreamId)).get();
  if (!upstream) return notFound("Upstream not found");

  const { upstreamId, toolName, subjects } = parsed.data;

  // The discovery row is the evidence the tool exists; a grant on an unknown tool is still
  // allowed (grant_tools may predate a removal, §7.4 "orphelins") but we flag it clearly.
  const discovery = db
    .select()
    .from(toolDiscoveries)
    .where(and(eq(toolDiscoveries.upstreamId, upstreamId), eq(toolDiscoveries.toolName, toolName)))
    .get();

  try {
    const result = grantToolToSubjects(upstreamId, toolName, subjects, guard.actor);

    // Granting from the discoveries banner implicitly acknowledges the item.
    if (discovery && discovery.acknowledgedAt === null) {
      db.update(toolDiscoveries)
        .set({ acknowledgedAt: Date.now() })
        .where(and(eq(toolDiscoveries.upstreamId, upstreamId), eq(toolDiscoveries.toolName, toolName)))
        .run();
    }

    if (result.granted.length === 0) {
      return json({
        ...result,
        warning: "No subject needed a change (all selected subjects already have every tool).",
      });
    }
    return json(result);
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Failed to grant the tool");
  }
}
