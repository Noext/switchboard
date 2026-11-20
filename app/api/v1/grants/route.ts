import { upsertGrant } from "@/lib/auth/grants";
import { guardResponse, json, parseBody, requireAdmin, badRequest } from "@/lib/api/guard";
import { grantSchema } from "@/lib/api/schemas";
import { getDb } from "@/lib/db";
import { apiKeys, roles, upstreams } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { emitUiEvent } from "@/lib/events";

/**
 * PUT /api/v1/grants   body: { subjectType: "role"|"key", subjectId, upstreamId,
 *                              toolMode: "all"|"selected", tools?: string[], prompts?, resources? }
 *   -> { grant: { id, subjectType, subjectId, upstreamId, toolMode, tools[], prompts, resources },
 *        effective?: EffectiveAccessView }   (effective only when subjectType = "key")
 *   Upsert on (subjectType, subjectId, upstreamId). `toolMode:"all"` also covers tools that
 *   appear later (spec §7.3); `selected` stores exactly `tools`.
 */
export async function PUT(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const parsed = await parseBody(req, grantSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const db = getDb();

  const upstream = db.select().from(upstreams).where(eq(upstreams.id, body.upstreamId)).get();
  if (!upstream) return badRequest("Unknown upstreamId");
  if (body.subjectType === "key") {
    if (!db.select().from(apiKeys).where(eq(apiKeys.id, body.subjectId)).get()) return badRequest("Unknown subjectId (key)");
  } else if (!db.select().from(roles).where(eq(roles.id, body.subjectId)).get()) {
    return badRequest("Unknown subjectId (role)");
  }

  const { id } = upsertGrant(
    {
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      upstreamId: body.upstreamId,
      toolMode: body.toolMode,
      tools: body.tools,
      prompts: body.prompts,
      resources: body.resources,
    },
    guard.actor,
  );
  emitUiEvent("grant.changed", { grantId: id, subjectType: body.subjectType, subjectId: body.subjectId, upstreamId: body.upstreamId });
  if (body.subjectType === "key") emitUiEvent("key.changed", { keyId: body.subjectId, action: "grant" });

  let effective: unknown = undefined;
  if (body.subjectType === "key") {
    const { buildEffectiveAccessView } = await import("@/lib/api/access-view");
    effective = buildEffectiveAccessView(body.subjectId);
  }

  return json({
    grant: {
      id,
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      upstreamId: body.upstreamId,
      toolMode: body.toolMode,
      tools: body.toolMode === "selected" ? body.tools : [],
      prompts: body.prompts,
      resources: body.resources,
    },
    ...(effective === undefined ? {} : { effective }),
  });
}
