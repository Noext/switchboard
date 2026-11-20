import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { apiKeys, callLogs, upstreams } from "@/lib/db/schema";
import { guardResponse, json, requireAdmin } from "@/lib/api/guard";
import { boolParam, clampLimit, intParam, sinceParam } from "@/lib/api/util";

/**
 * GET /api/v1/logs?key=&upstream=&name=&ok=&denied=&limit=&since=&cursor=
 *   spec §8 "Journal": filterable call log.
 *   Filters: key (key id or name), upstream (id or slug), name (tool name substring),
 *            ok=true|false, denied=true|false, limit (default 100, max 500),
 *            since (epoch ms or ISO), until (epoch ms or ISO).
 *   -> { items: CallView[], total: number, nextCursor: string|null }
 *   CallView = call_logs row + keyName, upstreamSlug, upstreamName.
 *   Previews are already redacted (2 KB cap) by the logging layer.
 */
export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const url = new URL(req.url);
  const db = getDb();

  const keyParam = url.searchParams.get("key");
  const upstreamParam = url.searchParams.get("upstream");
  const nameParam = url.searchParams.get("name");
  const okParam = boolParam(url, "ok");
  const deniedParam = boolParam(url, "denied");
  const limit = clampLimit(intParam(url, "limit", 100), 100, 500);
  const since = sinceParam(url, "since");
  const until = sinceParam(url, "until");
  const cursor = url.searchParams.get("cursor");

  const conditions: SQL[] = [];
  if (since !== null) conditions.push(gte(callLogs.at, since));
  if (until !== null) conditions.push(lte(callLogs.at, until));
  if (okParam !== null) conditions.push(eq(callLogs.ok, okParam));
  if (deniedParam !== null) conditions.push(eq(callLogs.denied, deniedParam));
  if (nameParam) conditions.push(sql`${callLogs.name} LIKE ${"%" + nameParam + "%"}`);
  if (cursor) conditions.push(sql`${callLogs.at} < ${Number(cursor) || 0}`);

  if (keyParam) {
    const key = db.select().from(apiKeys).where(eq(apiKeys.id, keyParam)).get();
    if (key) conditions.push(eq(callLogs.keyId, key.id));
    else conditions.push(eq(callLogs.keyId, "__unknown__"));
  }
  if (upstreamParam) {
    const upstream = db.select().from(upstreams).where(eq(upstreams.id, upstreamParam)).get();
    if (upstream) conditions.push(eq(callLogs.upstreamId, upstream.id));
    else {
      const bySlug = db.select().from(upstreams).where(eq(upstreams.slug, upstreamParam)).get();
      conditions.push(eq(callLogs.upstreamId, bySlug?.id ?? "__unknown__"));
    }
  }

  const where = conditions.length ? and(...conditions) : undefined;
  const rows = db
    .select()
    .from(callLogs)
    .where(where)
    .orderBy(desc(callLogs.at))
    .limit(limit)
    .all();

  const total = db
    .select({ n: sql<number>`coalesce(count(*), 0)` })
    .from(callLogs)
    .where(where)
    .get();

  const keyRows = db.select().from(apiKeys).all();
  const keyNames = new Map(keyRows.map((k) => [k.id, k.name]));
  const upstreamRows = db.select().from(upstreams).all();
  const upstreamById = new Map(upstreamRows.map((u) => [u.id, u]));

  return json({
    items: rows.map((row) => {
      const upstream = row.upstreamId ? upstreamById.get(row.upstreamId) : undefined;
      return {
        ...row,
        keyName: row.keyId ? keyNames.get(row.keyId) ?? null : null,
        upstreamSlug: upstream?.slug ?? null,
        upstreamName: upstream?.name ?? null,
      };
    }),
    total: total?.n ?? 0,
    nextCursor: rows.length === limit ? String(rows[rows.length - 1]?.at ?? "") : null,
  });
}
