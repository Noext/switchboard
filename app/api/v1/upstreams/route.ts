import { desc } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { upstreams } from "@/lib/db/schema";
import { conflict, guardResponse, json, parseBody, requireAdmin } from "@/lib/api/guard";
import { upstreamCreateSchema } from "@/lib/api/schemas";
import { createUpstream } from "@/lib/api/upstreams";
import { serializeUpstream } from "@/lib/api/serialize";

/**
 * GET /api/v1/upstreams
 *   -> { items: UpstreamView[] }
 *   UpstreamView = upstream row + derived counts { tools, prompts, resources, resourceTemplates,
 *   keyCount, roleCount, p50Ms }, live runtime { status, toolCount, stderrLines } | null, and
 *   secret flags (hasEnv/envKeys/hasHeaders/headerKeys/hasOAuth) — never secret values.
 *
 * POST /api/v1/upstreams  body: upstreamCreateSchema (+ optional `access` section, spec §7.4)
 *   -> 201 { upstream: UpstreamView, grants: number }
 *   Secrets (env, headers, bearerToken, oauth) are encrypted before storage and never returned.
 */
export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const rows = getDb().select().from(upstreams).orderBy(desc(upstreams.createdAt)).all();
  return json({ items: rows.map((row) => serializeUpstream(row)) });
}

export async function POST(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const parsed = await parseBody(req, upstreamCreateSchema);
  if (!parsed.ok) return parsed.response;
  try {
    const { view, grants } = createUpstream(parsed.data, guard.actor);
    return json({ upstream: view, grants }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create upstream";
    if (/unique|UNIQUE constraint/i.test(message)) return conflict("An upstream with this slug already exists");
    return json({ error: message }, { status: 500 });
  }
}
