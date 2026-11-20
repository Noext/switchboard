import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { apiKeys, callLogs, feedback, keyRoles, roles, toolDiscoveries, upstreams } from "@/lib/db/schema";
import { guardResponse, json, requireAdmin } from "@/lib/api/guard";
import { serializeUpstream } from "@/lib/api/serialize";
import { getSettings } from "@/lib/settings";
import { hasUpstreamManager, getUpstreamManager } from "@/lib/upstreams/types";
import { getCatalogSnapshot } from "@/lib/catalog/catalog";
import { listOpenSessions } from "@/lib/api/status-hooks";

/**
 * GET /api/v1/status   — aggregated dashboard payload (spec §8 Dashboard)
 *   -> {
 *        upstreams: { total, byStatus: Record<status, number>, items: UpstreamView[] },
 *        keys:      { total, active, revoked, expired, agent, admin },
 *        calls24h:  number,
 *        errors24h: number,
 *        denials24h:number,
 *        recentErrors: [{ id, at, keyId, keyName, upstreamId, upstreamSlug, name, errorCode }] (last 20),
 *        feedback:  { unreadBySeverity: { low, medium, high, blocking }, totalNew, last5: [...] },
 *        oauthRequired: [{ id, slug, name, lastError }],
 *        discoveries: { total, unacknowledged, items: [{ upstreamId, slug, toolName, publicName, firstSeenAt }] },
 *        catalog:   { version, builtAt, toolCount },
 *        gateway:   { runtime: boolean, sessions: number },
 *        sessions / openSessions: SessionSummary[]   // same array twice, for UI compatibility
 *      }
 *   Open sessions come from registerSessionProvider() (lib/api/status-hooks.ts); without a
 *   registered provider the arrays are empty and `gateway.sessions` is 0.
 */
export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const db = getDb();
  const now = Date.now();
  const dayAgo = now - 86_400_000;

  const upstreamRows = db.select().from(upstreams).all();
  const byStatus: Record<string, number> = {
    ready: 0,
    connecting: 0,
    degraded: 0,
    auth_required: 0,
    error: 0,
    disabled: 0,
  };
  for (const row of upstreamRows) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;

  const keyRows = db.select().from(apiKeys).all();
  const keyNames = new Map(keyRows.map((k) => [k.id, k.name]));
  const upstreamSlugs = new Map(upstreamRows.map((u) => [u.id, u.slug]));

  const calls = db
    .select({
      total: sql<number>`coalesce(count(*), 0)`,
      errors: sql<number>`coalesce(sum(case when ok = 0 then 1 else 0 end), 0)`,
      denied: sql<number>`coalesce(sum(case when denied = 1 then 1 else 0 end), 0)`,
    })
    .from(callLogs)
    .where(gte(callLogs.at, dayAgo))
    .get();

  const recentErrors = db
    .select()
    .from(callLogs)
    .where(and(gte(callLogs.at, dayAgo), eq(callLogs.ok, false)))
    .orderBy(desc(callLogs.at))
    .limit(20)
    .all()
    .map((row) => ({
      id: row.id,
      at: row.at,
      keyId: row.keyId,
      keyName: row.keyId ? keyNames.get(row.keyId) ?? null : null,
      upstreamId: row.upstreamId,
      upstreamSlug: row.upstreamId ? upstreamSlugs.get(row.upstreamId) ?? null : null,
      name: row.name,
      errorCode: row.errorCode,
      denied: row.denied,
    }));

  const severityRows = db
    .select({ severity: feedback.severity, n: sql<number>`count(*)` })
    .from(feedback)
    .where(eq(feedback.status, "new"))
    .groupBy(feedback.severity)
    .all();
  const unreadBySeverity = { low: 0, medium: 0, high: 0, blocking: 0 } as Record<string, number>;
  for (const row of severityRows) unreadBySeverity[row.severity] = row.n;

  const totalNew = db
    .select({ n: sql<number>`coalesce(count(*), 0)` })
    .from(feedback)
    .where(eq(feedback.status, "new"))
    .get();

  const last5Feedback = db
    .select()
    .from(feedback)
    .orderBy(desc(feedback.lastOccurrenceAt))
    .limit(5)
    .all()
    .map((row) => ({
      id: row.id,
      severity: row.severity,
      category: row.category,
      title: row.title,
      status: row.status,
      keyId: row.keyId,
      keyName: keyNames.get(row.keyId) ?? null,
      upstreamSlug: row.upstreamSlug,
      toolName: row.toolName,
      occurrences: row.occurrences,
      lastOccurrenceAt: row.lastOccurrenceAt,
    }));

  const discoveryRows = db.select().from(toolDiscoveries).all();
  const snapshot = getCatalogSnapshot();
  const discoveries = {
    total: discoveryRows.length,
    unacknowledged: discoveryRows.filter((d) => d.acknowledgedAt === null).length,
    items: discoveryRows
      .filter((d) => d.acknowledgedAt === null)
      .sort((a, b) => b.firstSeenAt - a.firstSeenAt)
      .slice(0, 50)
      .map((d) => {
        const view = snapshot.upstreams[d.upstreamId];
        return {
          upstreamId: d.upstreamId,
          slug: view?.slug ?? upstreamSlugs.get(d.upstreamId) ?? null,
          toolName: d.toolName,
          publicName: view?.toolPublicNames.get(d.toolName) ?? null,
          firstSeenAt: d.firstSeenAt,
        };
      }),
  };

  const oauthRequired = upstreamRows
    .filter((row) => row.status === "auth_required" || row.authType === "oauth" && row.status === "error")
    .map((row) => ({ id: row.id, slug: row.slug, name: row.name, lastError: row.lastError }));

  const manager = hasUpstreamManager() ? getUpstreamManager() : null;
  const settings = getSettings();
  const sessions = listOpenSessions();

  return json({
    upstreams: {
      total: upstreamRows.length,
      byStatus,
      items: upstreamRows.map((row) => serializeUpstream(row)),
    },
    keys: {
      total: keyRows.length,
      active: keyRows.filter((k) => k.revokedAt === null && (k.expiresAt === null || k.expiresAt > now)).length,
      revoked: keyRows.filter((k) => k.revokedAt !== null).length,
      expired: keyRows.filter((k) => k.revokedAt === null && k.expiresAt !== null && k.expiresAt <= now).length,
      agent: keyRows.filter((k) => k.scope === "agent").length,
      admin: keyRows.filter((k) => k.scope === "admin").length,
      roles: db.select({ n: sql<number>`coalesce(count(*), 0)` }).from(roles).get()?.n ?? 0,
      roleLinks: db.select({ n: sql<number>`coalesce(count(*), 0)` }).from(keyRoles).get()?.n ?? 0,
    },
    calls24h: calls?.total ?? 0,
    errors24h: calls?.errors ?? 0,
    denials24h: calls?.denied ?? 0,
    recentErrors,
    feedback: {
      unreadBySeverity,
      totalNew: totalNew?.n ?? 0,
      last5: last5Feedback,
      enabled: settings.feedbackEnabled,
    },
    oauthRequired,
    discoveries,
    catalog: { version: snapshot.version, builtAt: snapshot.builtAt, toolCount: snapshot.toolsByPublicName.size },
    gateway: { runtime: Boolean(manager), sessions: sessions.length },
    // The UI reads `openSessions ?? sessions`; both are provided for compatibility.
    sessions,
    openSessions: sessions,
    generatedAt: now,
  });
}
