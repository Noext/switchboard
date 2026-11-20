import "server-only";
import { and, desc, eq, gte, inArray, isNull, like, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  apiKeys,
  callLogs,
  events,
  feedback,
  grants,
  itemOverrides,
  keyDenies,
  keyRoles,
  toolDiscoveries,
  upstreamItems,
  upstreams,
} from "@/lib/db/schema";
import { catalogFromDb } from "./catalog-db";
import { listKeys } from "@/lib/auth/keys";
import { listRoles } from "@/lib/auth/grants";
import { getSettings } from "@/lib/settings";
import { feedbackStats } from "@/lib/feedback";
import { getUpstreamManager, hasUpstreamManager } from "@/lib/upstreams/types";
import type { UpstreamStatus } from "@/lib/types";

/**
 * Server-side read helpers for the admin UI. Pages are server components and read the DB
 * directly (per the UI brief): no HTTP hop, no auth dance, same source of truth as the API.
 * Everything returned here is serialisable so it can be passed to client components as props.
 */

export const DAY = 86_400_000;

export interface UpstreamRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  transport: "http" | "sse" | "stdio";
  url: string | null;
  command: string | null;
  args: string[] | null;
  cwd: string | null;
  authType: "none" | "headers" | "bearer" | "oauth";
  enabled: boolean;
  startMode: "always" | "lazy";
  idleStopMinutes: number;
  callTimeoutSeconds: number;
  status: UpstreamStatus;
  lastError: string | null;
  lastReadyAt: number | null;
  capabilities: unknown;
  serverInfo: unknown;
  createdAt: number;
  updatedAt: number;
  toolCount: number;
  promptCount: number;
  resourceCount: number;
  keyAccessCount: number;
  roleAccessCount: number;
  p50Latency: number | null;
  callCount24h: number;
  errorCount24h: number;
}

function p50(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/** Full upstream list with the counters the Serveurs table and dashboard need. */
export function listUpstreamRows(): UpstreamRow[] {
  const db = getDb();
  const rows = db.select().from(upstreams).all().sort((a, b) => a.slug.localeCompare(b.slug));
  const items = db.select().from(upstreamItems).all();
  const counts = new Map<string, { tool: number; prompt: number; resource: number }>();
  for (const it of items) {
    const c = counts.get(it.upstreamId) ?? { tool: 0, prompt: 0, resource: 0 };
    if (it.kind === "tool") c.tool += 1;
    else if (it.kind === "prompt") c.prompt += 1;
    else if (it.kind === "resource") c.resource += 1;
    counts.set(it.upstreamId, c);
  }

  const since = Date.now() - DAY;
  const calls = db
    .select({ upstreamId: callLogs.upstreamId, durationMs: callLogs.durationMs, ok: callLogs.ok })
    .from(callLogs)
    .where(gte(callLogs.at, since))
    .all();
  const durations = new Map<string, number[]>();
  const callCount = new Map<string, number>();
  const errorCount = new Map<string, number>();
  for (const c of calls) {
    if (!c.upstreamId) continue;
    callCount.set(c.upstreamId, (callCount.get(c.upstreamId) ?? 0) + 1);
    if (!c.ok) errorCount.set(c.upstreamId, (errorCount.get(c.upstreamId) ?? 0) + 1);
    if (c.durationMs !== null) {
      const list = durations.get(c.upstreamId) ?? [];
      list.push(c.durationMs);
      durations.set(c.upstreamId, list);
    }
  }

  const keyGrantCount = new Map<string, number>();
  const roleGrantCount = new Map<string, number>();
  for (const g of db.select().from(grants).all()) {
    const map = g.subjectType === "key" ? keyGrantCount : roleGrantCount;
    map.set(g.upstreamId, (map.get(g.upstreamId) ?? 0) + 1);
  }

  return rows.map((u) => ({
    id: u.id,
    slug: u.slug,
    name: u.name,
    description: u.description,
    transport: u.transport,
    url: u.url,
    command: u.command,
    args: u.args,
    cwd: u.cwd,
    authType: u.authType,
    enabled: u.enabled,
    startMode: u.startMode,
    idleStopMinutes: u.idleStopMinutes,
    callTimeoutSeconds: u.callTimeoutSeconds,
    status: u.status,
    lastError: u.lastError,
    lastReadyAt: u.lastReadyAt,
    capabilities: u.capabilities,
    serverInfo: u.serverInfo,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    toolCount: counts.get(u.id)?.tool ?? 0,
    promptCount: counts.get(u.id)?.prompt ?? 0,
    resourceCount: counts.get(u.id)?.resource ?? 0,
    keyAccessCount: keyGrantCount.get(u.id) ?? 0,
    roleAccessCount: roleGrantCount.get(u.id) ?? 0,
    p50Latency: p50(durations.get(u.id) ?? []),
    callCount24h: callCount.get(u.id) ?? 0,
    errorCount24h: errorCount.get(u.id) ?? 0,
  }));
}

export function getUpstreamRow(id: string): UpstreamRow | null {
  return listUpstreamRows().find((u) => u.id === id) ?? null;
}

export interface ShellCounts {
  feedbackUnread: number;
  serversAuthRequired: number;
  keysActive: number;
  serversReady: number;
  serversError: number;
}

/** Counters shown in the sidebar and used for dashboard banners. */
export function shellCounts(): ShellCounts {
  const db = getDb();
  const ups = db.select({ status: upstreams.status }).from(upstreams).all();
  const keys = db.select({ revokedAt: apiKeys.revokedAt, expiresAt: apiKeys.expiresAt }).from(apiKeys).all();
  const now = Date.now();
  return {
    feedbackUnread: safeNewFeedbackCount(),
    serversAuthRequired: ups.filter((u) => u.status === "auth_required").length,
    serversReady: ups.filter((u) => u.status === "ready").length,
    serversError: ups.filter((u) => u.status === "error" || u.status === "degraded").length,
    keysActive: keys.filter((k) => !k.revokedAt && (!k.expiresAt || k.expiresAt > now)).length,
  };
}

function safeNewFeedbackCount(): number {
  try {
    return feedbackStats().byStatus.new;
  } catch {
    return 0;
  }
}

/** Open feedback by severity + the 5 most recent (dashboard, §8). */
export function dashboardFeedback() {
  const db = getDb();
  const rows = db
    .select()
    .from(feedback)
    .where(inArray(feedback.status, ["new", "acknowledged", "in_progress"]))
    .orderBy(desc(feedback.lastOccurrenceAt))
    .limit(50)
    .all();
  const bySeverity = { blocking: 0, high: 0, medium: 0, low: 0 };
  for (const r of rows) bySeverity[r.severity] += 1;
  const keyNames = new Map(
    db.select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys).all().map((k) => [k.id, k.name]),
  );
  return {
    open: rows.length,
    bySeverity,
    latest: rows.slice(0, 5).map((r) => ({ ...r, keyName: keyNames.get(r.keyId) ?? null })),
  };
}

/** New tools detected but not acknowledged (dashboard banner, §7.4). */
export function newDiscoveries() {
  const db = getDb();
  const rows = db
    .select()
    .from(toolDiscoveries)
    .where(isNull(toolDiscoveries.acknowledgedAt))
    .orderBy(desc(toolDiscoveries.firstSeenAt))
    .all();
  const upRows = db.select({ id: upstreams.id, slug: upstreams.slug, name: upstreams.name }).from(upstreams).all();
  const byId = new Map(upRows.map((u) => [u.id, u]));
  return rows.map((r) => ({
    upstreamId: r.upstreamId,
    upstreamSlug: byId.get(r.upstreamId)?.slug ?? null,
    upstreamName: byId.get(r.upstreamId)?.name ?? null,
    toolName: r.toolName,
    firstSeenAt: r.firstSeenAt,
  }));
}

export interface CallStats {
  calls24h: number;
  denied24h: number;
  errors24h: number;
  calls7d: number;
  denied7d: number;
}

export function callStats(): CallStats {
  const db = getDb();
  const now = Date.now();
  const day = db
    .select({ ok: callLogs.ok, denied: callLogs.denied })
    .from(callLogs)
    .where(gte(callLogs.at, now - DAY))
    .all();
  const week = db
    .select({ ok: callLogs.ok, denied: callLogs.denied })
    .from(callLogs)
    .where(gte(callLogs.at, now - 7 * DAY))
    .all();
  const denied = (rows: Array<{ ok: boolean; denied: boolean }>) => rows.filter((r) => r.denied).length;
  const errors = (rows: Array<{ ok: boolean; denied: boolean }>) => rows.filter((r) => !r.ok && !r.denied).length;
  return {
    calls24h: day.length,
    denied24h: denied(day),
    errors24h: errors(day),
    calls7d: week.length,
    denied7d: denied(week),
  };
}

/** Per-key usage counters for the Clés API table. */
export function keyUsage(): Map<string, { calls24h: number; calls7d: number; denied24h: number; lastCallAt: number | null }> {
  const db = getDb();
  const now = Date.now();
  const rows = db
    .select({ keyId: callLogs.keyId, at: callLogs.at, ok: callLogs.ok, denied: callLogs.denied })
    .from(callLogs)
    .where(gte(callLogs.at, now - 7 * DAY))
    .all();
  const out = new Map<string, { calls24h: number; calls7d: number; denied24h: number; lastCallAt: number | null }>();
  for (const r of rows) {
    if (!r.keyId) continue;
    const entry = out.get(r.keyId) ?? { calls24h: 0, calls7d: 0, denied24h: 0, lastCallAt: null };
    entry.calls7d += 1;
    if (r.at >= now - DAY) {
      entry.calls24h += 1;
      if (r.denied) entry.denied24h += 1;
    }
    if (entry.lastCallAt === null || r.at > entry.lastCallAt) entry.lastCallAt = r.at;
    out.set(r.keyId, entry);
  }
  return out;
}

export interface LogFilters {
  keyId?: string;
  upstreamId?: string;
  name?: string;
  outcome?: "all" | "ok" | "error" | "denied";
  kind?: string;
  sinceHours?: number;
  limit?: number;
  offset?: number;
}

export interface LogRow {
  id: string;
  at: number;
  keyId: string | null;
  keyName: string | null;
  upstreamId: string | null;
  upstreamSlug: string | null;
  sessionId: string | null;
  kind: string;
  name: string;
  argsPreview: string | null;
  resultPreview: string | null;
  ok: boolean;
  denied: boolean;
  errorCode: string | null;
  durationMs: number | null;
}

function decorateLogs(rows: Array<typeof callLogs.$inferSelect>): LogRow[] {
  const db = getDb();
  const keyNames = new Map(
    db.select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys).all().map((k) => [k.id, k.name]),
  );
  const slugById = new Map(
    db.select({ id: upstreams.id, slug: upstreams.slug }).from(upstreams).all().map((u) => [u.id, u.slug]),
  );
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    keyId: r.keyId,
    keyName: r.keyId ? (keyNames.get(r.keyId) ?? null) : null,
    upstreamId: r.upstreamId,
    upstreamSlug: r.upstreamId ? (slugById.get(r.upstreamId) ?? null) : null,
    sessionId: r.sessionId,
    kind: r.kind,
    name: r.name,
    argsPreview: r.argsPreview,
    resultPreview: r.resultPreview,
    ok: r.ok,
    denied: r.denied,
    errorCode: r.errorCode,
    durationMs: r.durationMs,
  }));
}

export function listCallLogs(filters: LogFilters = {}): { items: LogRow[]; total: number } {
  const db = getDb();
  const conditions: ReturnType<typeof eq>[] = [];
  if (filters.keyId) conditions.push(eq(callLogs.keyId, filters.keyId) as ReturnType<typeof eq>);
  if (filters.upstreamId) conditions.push(eq(callLogs.upstreamId, filters.upstreamId) as ReturnType<typeof eq>);
  if (filters.name) conditions.push(like(callLogs.name, "%" + filters.name + "%") as ReturnType<typeof eq>);
  if (filters.kind && filters.kind !== "all") conditions.push(eq(callLogs.kind, filters.kind) as ReturnType<typeof eq>);
  if (filters.outcome === "ok") conditions.push(eq(callLogs.ok, true) as ReturnType<typeof eq>);
  if (filters.outcome === "denied") conditions.push(eq(callLogs.denied, true) as ReturnType<typeof eq>);
  if (filters.outcome === "error") {
    conditions.push(eq(callLogs.ok, false) as ReturnType<typeof eq>);
    conditions.push(eq(callLogs.denied, false) as ReturnType<typeof eq>);
  }
  if (filters.sinceHours && filters.sinceHours > 0) {
    conditions.push(gte(callLogs.at, Date.now() - filters.sinceHours * 3_600_000) as ReturnType<typeof eq>);
  }
  const where = conditions.length ? and(...conditions) : undefined;
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  const rows = db.select().from(callLogs).where(where).orderBy(desc(callLogs.at)).limit(limit).offset(offset).all();
  const total = db.select({ n: sql<number>`count(*)` }).from(callLogs).where(where).get()?.n ?? 0;
  return { items: decorateLogs(rows), total };
}

export function getCallLog(id: string): LogRow | null {
  const db = getDb();
  const row = db.select().from(callLogs).where(eq(callLogs.id, id)).get();
  return row ? (decorateLogs([row])[0] ?? null) : null;
}

export function callsForKey(keyId: string, limit = 25): LogRow[] {
  const db = getDb();
  return decorateLogs(
    db.select().from(callLogs).where(eq(callLogs.keyId, keyId)).orderBy(desc(callLogs.at)).limit(limit).all(),
  );
}

export interface EventRow {
  id: string;
  at: number;
  actor: string;
  type: string;
  upstreamId: string | null;
  message: string;
  data: unknown;
}

export function listEvents(
  filter: { keyId?: string; types?: string[]; upstreamId?: string; limit?: number } = {},
): EventRow[] {
  const db = getDb();
  const conditions: ReturnType<typeof eq>[] = [];
  if (filter.upstreamId) conditions.push(eq(events.upstreamId, filter.upstreamId) as ReturnType<typeof eq>);
  if (filter.types && filter.types.length) conditions.push(inArray(events.type, filter.types) as ReturnType<typeof eq>);
  if (filter.keyId) {
    conditions.push(like(events.data as never, "%" + filter.keyId + "%") as ReturnType<typeof eq>);
  }
  const where = conditions.length ? and(...conditions) : undefined;
  return db
    .select()
    .from(events)
    .where(where)
    .orderBy(desc(events.at))
    .limit(Math.min(filter.limit ?? 100, 500))
    .all();
}

/** Server-only stderr snapshot for stdio upstreams (guarded: the manager may not be wired). */
export function stderrFor(upstreamId: string): string[] {
  if (!hasUpstreamManager()) return [];
  try {
    return getUpstreamManager().getStderr(upstreamId);
  } catch {
    return [];
  }
}

export function runtimeStateFor(upstreamId: string) {
  if (!hasUpstreamManager()) return null;
  try {
    return getUpstreamManager().getState(upstreamId);
  } catch {
    return null;
  }
}

/** Catalog tools for one upstream, with per-item override state (server tabs). */
export interface CatalogItemRow {
  kind: "tool" | "prompt" | "resource" | "resource_template";
  name: string;
  publicName: string;
  description: string | null;
  enabled: boolean;
  alias: string | null;
  descriptionOverride: string | null;
  truncated: boolean;
  definition: unknown;
}

export function catalogItemsFor(upstreamId: string): CatalogItemRow[] {
  const view = catalogFromDb().find((u) => u.id === upstreamId);
  if (!view) return [];

  // Overrides drive the alias/description/enabled columns shown by the tabs.
  const db = getDb();
  const overrides = new Map(
    db
      .select()
      .from(itemOverrides)
      .where(eq(itemOverrides.upstreamId, upstreamId))
      .all()
      .map((o) => [o.kind + "|" + o.name, o] as const),
  );
  const itemDefs = new Map(
    db
      .select()
      .from(upstreamItems)
      .where(eq(upstreamItems.upstreamId, upstreamId))
      .all()
      .map((i) => [i.kind + "|" + i.name, i] as const),
  );

  const rows: CatalogItemRow[] = [];
  const push = (
    kind: CatalogItemRow["kind"],
    name: string,
    publicName: string,
    description: string | null,
    globallyDisabled: boolean,
  ) => {
    const override = overrides.get(kind + "|" + name);
    const def = itemDefs.get(kind + "|" + name);
    rows.push({
      kind,
      name,
      publicName,
      description,
      // The tabs must show the *effective* switch state: a global override wins over the default.
      enabled: override ? override.enabled : !globallyDisabled,
      alias: override?.alias ?? null,
      descriptionOverride: override?.descriptionOverride ?? null,
      truncated: publicName.length >= 46,
      definition: def?.definition ?? null,
    });
  };

  for (const tool of view.tools) push("tool", tool.name, tool.publicName, tool.description, tool.globallyDisabled);
  for (const prompt of view.prompts) push("prompt", prompt.name, prompt.publicName, prompt.description, false);
  for (const resource of view.resources) push("resource", resource.name, resource.publicName, resource.description, false);
  for (const template of view.resourceTemplates) push("resource_template", template.name, template.publicName, template.description, false);
  return rows;
}

/** Upstream catalog used by the access editor: tools/prompts/resources per upstream. */
export interface UpstreamToolsForEditor {
  id: string;
  slug: string;
  name: string;
  status: string;
  enabled: boolean;
  tools: Array<{ name: string; publicName: string; description: string | null; enabled: boolean }>;
  promptCount: number;
  resourceCount: number;
}

export function upstreamsForEditor(): UpstreamToolsForEditor[] {
  return catalogFromDb().map((view) => ({
    id: view.id,
    slug: view.slug,
    name: view.name,
    status: view.status,
    enabled: view.enabled,
    tools: view.tools.map((t) => ({
      name: t.name,
      publicName: t.publicName,
      description: t.description,
      enabled: !t.globallyDisabled,
    })),
    promptCount: view.prompts.length,
    resourceCount: view.resources.length,
  }));
}

/** Global overrides, for the "désactivé" badges in the access editor. */
export function disabledToolsByUpstream(): Record<string, string[]> {
  const db = getDb();
  const out: Record<string, string[]> = {};
  for (const row of db.select().from(itemOverrides).all()) {
    if (row.enabled || row.kind !== "tool") continue;
    (out[row.upstreamId] ??= []).push(row.name);
  }
  return out;
}

export function deniesForKey(keyId: string): Array<{ upstreamId: string; toolName: string | null }> {
  const db = getDb();
  return db
    .select()
    .from(keyDenies)
    .where(eq(keyDenies.keyId, keyId))
    .all()
    .map((d) => ({ upstreamId: d.upstreamId, toolName: d.toolName }));
}


// ---------------------------------------------------------------------------------------------
// Dashboard helpers
// ---------------------------------------------------------------------------------------------

/** Recent failing calls (not denials) for the dashboard "erreurs récentes" card. */
export function recentErrors(limit = 8): LogRow[] {
  const db = getDb();
  const rows = db
    .select()
    .from(callLogs)
    .where(and(eq(callLogs.ok, false), eq(callLogs.denied, false)))
    .orderBy(desc(callLogs.at))
    .limit(limit)
    .all();
  return decorateLogs(rows);
}

/** Recent denials (useful to spot a key with missing rights). */
export function recentDenials(limit = 8): LogRow[] {
  const db = getDb();
  return decorateLogs(
    db.select().from(callLogs).where(eq(callLogs.denied, true)).orderBy(desc(callLogs.at)).limit(limit).all(),
  );
}

export interface UpstreamStatusCount {
  status: UpstreamStatus;
  count: number;
}

export function upstreamStatusCounts(): UpstreamStatusCount[] {
  const db = getDb();
  const rows = db.select({ status: upstreams.status }).from(upstreams).all();
  const order: UpstreamStatus[] = ["ready", "connecting", "degraded", "auth_required", "error", "disabled"];
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  return order.map((status) => ({ status, count: counts.get(status) ?? 0 }));
}

/** Keys with no roles and no own grants — a security smell worth surfacing on the dashboard. */
export function keysWithoutAccess(): Array<{ id: string; name: string }> {
  const db = getDb();
  const keys = db.select({ id: apiKeys.id, name: apiKeys.name, scope: apiKeys.scope }).from(apiKeys).all();
  const grantedKeyIds = new Set(
    db.select({ subjectId: grants.subjectId }).from(grants).where(eq(grants.subjectType, "key")).all().map((g) => g.subjectId),
  );
  const rolesByKey = new Map<string, number>();
  for (const r of db.select().from(keyRolesTable()).all()) {
    rolesByKey.set(r.keyId, (rolesByKey.get(r.keyId) ?? 0) + 1);
  }
  return keys
    .filter((k) => k.scope === "agent" && !grantedKeyIds.has(k.id) && (rolesByKey.get(k.id) ?? 0) === 0)
    .map((k) => ({ id: k.id, name: k.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function keyRolesTable() {
  return keyRoles;
}

export { listKeys, listRoles, getSettings };