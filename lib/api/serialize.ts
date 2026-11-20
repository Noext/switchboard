import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  apiKeys,
  callLogs,
  grants,
  grantTools,
  itemOverrides,
  keyDenies,
  keyRoles,
  roles,
  toolDiscoveries,
  upstreamItems,
  upstreams,
} from "../db/schema";
import { hasUpstreamManager, getUpstreamManager } from "../upstreams/types";
import { secretKeys } from "./secrets";

/**
 * Plain-JSON serializers for the admin API. Everything returned here is safe to send to the
 * browser: encrypted columns are reduced to key-name lists and booleans.
 */

type UpstreamRow = typeof upstreams.$inferSelect;

export interface UpstreamCounts {
  tools: number;
  prompts: number;
  resources: number;
  resourceTemplates: number;
  /** Number of keys that have access, directly or through a role. */
  keyCount: number;
  roleCount: number;
  /** p50 call duration over the last 24h, ms (null when no calls). */
  p50Ms: number | null;
}

export interface UpstreamView {
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
  // Secrets are never returned: booleans and names only.
  hasEnv: boolean;
  envKeys: string[];
  hasHeaders: boolean;
  headerKeys: string[];
  hasOAuth: boolean;
  enabled: boolean;
  startMode: "always" | "lazy";
  idleStopMinutes: number;
  callTimeoutSeconds: number;
  status: UpstreamRow["status"];
  lastError: string | null;
  lastReadyAt: number | null;
  capabilities: unknown;
  serverInfo: unknown;
  createdAt: number;
  updatedAt: number;
  /** Live runtime state from the manager, when it is initialised. */
  runtime: { status: string; toolCount: number; stderrLines: number } | null;
  counts: UpstreamCounts;
}

export function itemCounts(upstreamId: string): {
  tools: number;
  prompts: number;
  resources: number;
  resourceTemplates: number;
} {
  const db = getDb();
  const rows = db
    .select({ kind: upstreamItems.kind, n: sql<number>`count(*)` })
    .from(upstreamItems)
    .where(eq(upstreamItems.upstreamId, upstreamId))
    .groupBy(upstreamItems.kind)
    .all();
  const out = { tools: 0, prompts: 0, resources: 0, resourceTemplates: 0 };
  for (const row of rows) {
    if (row.kind === "tool") out.tools = row.n;
    else if (row.kind === "prompt") out.prompts = row.n;
    else if (row.kind === "resource") out.resources = row.n;
    else if (row.kind === "resource_template") out.resourceTemplates = row.n;
  }
  return out;
}

/** Direct key grants + keys that inherit an upstream through one of their roles. */
export function subjectsWithAccess(upstreamId: string): { keyCount: number; roleCount: number } {
  const db = getDb();
  const grantRows = db.select().from(grants).where(eq(grants.upstreamId, upstreamId)).all();
  const directKeyIds = grantRows.filter((g) => g.subjectType === "key").map((g) => g.subjectId);
  const roleIds = grantRows.filter((g) => g.subjectType === "role").map((g) => g.subjectId);
  const throughRoles = roleIds.length
    ? db.select().from(keyRoles).where(inArray(keyRoles.roleId, roleIds)).all().map((r) => r.keyId)
    : [];
  const keyIds = new Set([...directKeyIds, ...throughRoles]);
  return { keyCount: keyIds.size, roleCount: roleIds.length };
}

function p50For(upstreamId: string): number | null {
  const db = getDb();
  const since = Date.now() - 86_400_000;
  const durations = db
    .select({ durationMs: callLogs.durationMs })
    .from(callLogs)
    .where(and(eq(callLogs.upstreamId, upstreamId), gte(callLogs.at, since)))
    .all()
    .map((r) => r.durationMs)
    .filter((v): v is number => typeof v === "number")
    .sort((a, b) => a - b);
  if (!durations.length) return null;
  return durations[Math.floor((durations.length - 1) / 2)] ?? null;
}

export function countsFor(upstreamId: string): UpstreamCounts {
  return {
    ...itemCounts(upstreamId),
    ...subjectsWithAccess(upstreamId),
    p50Ms: p50For(upstreamId),
  };
}

export function serializeUpstream(row: UpstreamRow, withCounts = true): UpstreamView {
  const counts = withCounts
    ? countsFor(row.id)
    : { tools: 0, prompts: 0, resources: 0, resourceTemplates: 0, keyCount: 0, roleCount: 0, p50Ms: null };
  let runtime: UpstreamView["runtime"] = null;
  if (hasUpstreamManager()) {
    try {
      const state = getUpstreamManager().getState(row.id);
      if (state) runtime = { status: state.status, toolCount: state.toolCount, stderrLines: state.stderr.length };
    } catch {
      /* manager unavailable: fall back to the DB status */
    }
  }
  const envKeys = secretKeys(row.envEnc);
  const headerKeys = secretKeys(row.headersEnc);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    transport: row.transport,
    url: row.url,
    command: row.command,
    args: row.args ?? null,
    cwd: row.cwd,
    authType: row.authType,
    hasEnv: envKeys.length > 0,
    envKeys,
    hasHeaders: headerKeys.length > 0,
    headerKeys,
    hasOAuth: Boolean(row.oauthEnc),
    enabled: row.enabled,
    startMode: row.startMode,
    idleStopMinutes: row.idleStopMinutes,
    callTimeoutSeconds: row.callTimeoutSeconds,
    status: row.status,
    lastError: row.lastError,
    lastReadyAt: row.lastReadyAt,
    capabilities: row.capabilities,
    serverInfo: row.serverInfo,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    runtime,
    counts,
  };
}

/** All upstream ids that no longer exist (used to filter grants). */
export function existingUpstreamIds(): string[] {
  return getDb().select({ id: upstreams.id }).from(upstreams).all().map((r) => r.id);
}

export function upstreamById(id: string): UpstreamRow | null {
  return getDb().select().from(upstreams).where(eq(upstreams.id, id)).get() ?? null;
}

/** Removes every row that belongs to an upstream (items, overrides, grants, denies, discoveries). */
export function deleteUpstreamCascade(upstreamId: string): void {
  const db = getDb();
  const grantIds = db.select({ id: grants.id }).from(grants).where(eq(grants.upstreamId, upstreamId)).all().map((r) => r.id);
  if (grantIds.length) db.delete(grantTools).where(inArray(grantTools.grantId, grantIds)).run();
  db.delete(grants).where(eq(grants.upstreamId, upstreamId)).run();
  db.delete(keyDenies).where(eq(keyDenies.upstreamId, upstreamId)).run();
  db.delete(itemOverrides).where(eq(itemOverrides.upstreamId, upstreamId)).run();
  db.delete(upstreamItems).where(eq(upstreamItems.upstreamId, upstreamId)).run();
  db.delete(toolDiscoveries).where(eq(toolDiscoveries.upstreamId, upstreamId)).run();
}

/** Keys whose visible tool set changed — used to reason about UI refresh. */
export function keyIdsAffectedByUpstream(upstreamId: string): string[] {
  const db = getDb();
  const direct = db
    .select({ id: grants.subjectId })
    .from(grants)
    .where(and(eq(grants.upstreamId, upstreamId), eq(grants.subjectType, "key")))
    .all()
    .map((r) => r.id);
  const roleIds = db
    .select({ id: grants.subjectId })
    .from(grants)
    .where(and(eq(grants.upstreamId, upstreamId), eq(grants.subjectType, "role")))
    .all()
    .map((r) => r.id);
  const throughRoles = roleIds.length
    ? db.select({ id: keyRoles.keyId }).from(keyRoles).where(inArray(keyRoles.roleId, roleIds)).all().map((r) => r.id)
    : [];
  return Array.from(new Set([...direct, ...throughRoles]));
}

/** Subject labels for the "who has access" tab. */
export function subjectLabel(subjectType: "role" | "key", subjectId: string): string {
  const db = getDb();
  if (subjectType === "role") {
    return db.select().from(roles).where(eq(roles.id, subjectId)).get()?.name ?? subjectId;
  }
  return db.select().from(apiKeys).where(eq(apiKeys.id, subjectId)).get()?.name ?? subjectId;
}

/** Most recent error-ish call for a upstream, for the servers list "last error" column. */
export function lastErrorMessage(upstreamId: string): string | null {
  const row = getDb()
    .select({ errorCode: callLogs.errorCode, at: callLogs.at })
    .from(callLogs)
    .where(and(eq(callLogs.upstreamId, upstreamId), eq(callLogs.ok, false)))
    .orderBy(desc(callLogs.at))
    .limit(1)
    .get();
  return row?.errorCode ?? null;
}
