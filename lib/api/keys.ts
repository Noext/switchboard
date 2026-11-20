import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb } from "../db";
import { apiKeys, callLogs, grants, grantTools, keyDenies, keyRoles, roles } from "../db/schema";
import { createKey, getKey, roleIdsForKey, type KeyRecord } from "../auth/keys";
import { setKeyDenies, upsertGrant } from "../auth/grants";
import { buildEffectiveAccessView, type EffectiveAccessView } from "./access-view";
import { sessionsForKey, type SessionSummary } from "./status-hooks";

/** Read/write model for the `/keys` routes. Never returns a secret hash or a plaintext secret. */

export interface KeyCallStats {
  calls24h: number;
  errors24h: number;
  denied24h: number;
  calls7d: number;
  lastCallAt: number | null;
}

export function callStatsForKey(keyId: string): KeyCallStats {
  const db = getDb();
  const now = Date.now();
  const dayAgo = now - 86_400_000;
  const weekAgo = now - 7 * 86_400_000;
  const day = db
    .select({
      total: sql<number>`coalesce(count(*), 0)`,
      errors: sql<number>`coalesce(sum(case when ok = 0 then 1 else 0 end), 0)`,
      denied: sql<number>`coalesce(sum(case when denied = 1 then 1 else 0 end), 0)`,
    })
    .from(callLogs)
    .where(and(eq(callLogs.keyId, keyId), gte(callLogs.at, dayAgo)))
    .get();
  const week = db
    .select({ total: sql<number>`coalesce(count(*), 0)` })
    .from(callLogs)
    .where(and(eq(callLogs.keyId, keyId), gte(callLogs.at, weekAgo)))
    .get();
  return {
    calls24h: day?.total ?? 0,
    errors24h: day?.errors ?? 0,
    denied24h: day?.denied ?? 0,
    calls7d: week?.total ?? 0,
    lastCallAt: lastCallAtFor(keyId),
  };
}

function lastCallAtFor(keyId: string): number | null {
  const row = getDb()
    .select({ at: callLogs.at })
    .from(callLogs)
    .where(eq(callLogs.keyId, keyId))
    .orderBy(desc(callLogs.at))
    .limit(1)
    .get();
  return row?.at ?? null;
}

export interface KeyView {
  id: string;
  name: string;
  description: string | null;
  prefix: string;
  scope: "agent" | "admin";
  exposureMode: "direct" | "discovery";
  expiresAt: number | null;
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  rotatedAt: number | null;
  /** active | expired | revoked */
  status: "active" | "expired" | "revoked";
  roleIds: string[];
  roleNames: string[];
  counts: { upstreams: number; tools: number; prompts: number; resources: number; estimatedTokens: number };
  calls: KeyCallStats;
  /** Open MCP sessions, from the provider registered by the gateway (empty when none). */
  sessions: SessionSummary[];
}

export function keyStatus(key: KeyRecord): "active" | "expired" | "revoked" {
  if (key.revokedAt !== null) return "revoked";
  if (key.expiresAt !== null && key.expiresAt <= Date.now()) return "expired";
  return "active";
}

function roleNamesFor(roleIds: string[]): string[] {
  if (!roleIds.length) return [];
  const db = getDb();
  const all = db.select().from(roles).all();
  const map = new Map(all.map((r) => [r.id, r.name]));
  return roleIds.map((id) => map.get(id) ?? id).sort();
}

export function serializeKey(key: KeyRecord, view: EffectiveAccessView | null): KeyView {
  const effective = view ?? buildEffectiveAccessView(key.id);
  return {
    id: key.id,
    name: key.name,
    description: key.description,
    prefix: key.prefix,
    scope: key.scope,
    exposureMode: key.exposureMode,
    expiresAt: key.expiresAt,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
    rotatedAt: key.rotatedAt,
    status: keyStatus(key),
    roleIds: key.roleIds,
    roleNames: roleNamesFor(key.roleIds),
    counts: {
      upstreams: effective?.totals.upstreams ?? 0,
      tools: effective?.totals.tools ?? 0,
      prompts: effective?.totals.prompts ?? 0,
      resources: effective?.totals.resources ?? 0,
      estimatedTokens: effective?.totals.estimatedTokens ?? 0,
    },
    calls: callStatsForKey(key.id),
    sessions: sessionsForKey(key.id),
  };
}

export function serializeKeys(keys: KeyRecord[]): KeyView[] {
  return keys.map((k) => serializeKey(k, null));
}

/** The key's own grants (not inherited from roles), one row per upstream. */
export function ownGrantsForKey(keyId: string) {
  const db = getDb();
  const rows = db
    .select()
    .from(grants)
    .where(and(eq(grants.subjectType, "key"), eq(grants.subjectId, keyId)))
    .all();
  if (!rows.length) return [];
  const tools = db.select().from(grantTools).all();
  const byGrant = new Map<string, string[]>();
  for (const t of tools) {
    const list = byGrant.get(t.grantId) ?? [];
    list.push(t.toolName);
    byGrant.set(t.grantId, list);
  }
  return rows.map((g) => ({
    grantId: g.id,
    upstreamId: g.upstreamId,
    toolMode: g.toolMode,
    tools: (byGrant.get(g.id) ?? []).sort(),
    prompts: g.prompts,
    resources: g.resources,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  }));
}

/** Copies own grants, denies and (optionally) roles from a source key — "copier les droits de…". */
export function copyAccessFromKey(sourceKeyId: string, targetKeyId: string, actor: string, copyRoles: boolean): void {
  const db = getDb();
  const source = db.select().from(apiKeys).where(eq(apiKeys.id, sourceKeyId)).get();
  if (!source) throw new Error("source key not found");

  if (copyRoles) {
    const sourceRoles = roleIdsForKey(sourceKeyId);
    for (const roleId of sourceRoles) {
      db.insert(keyRoles).values({ keyId: targetKeyId, roleId }).onConflictDoNothing().run();
    }
  }

  for (const grant of ownGrantsForKey(sourceKeyId)) {
    upsertGrant(
      {
        subjectType: "key",
        subjectId: targetKeyId,
        upstreamId: grant.upstreamId,
        toolMode: grant.toolMode,
        tools: grant.tools,
        prompts: grant.prompts,
        resources: grant.resources,
      },
      actor,
    );
  }

  const denies = db.select().from(keyDenies).where(eq(keyDenies.keyId, sourceKeyId)).all();
  if (denies.length) {
    setKeyDenies(
      targetKeyId,
      denies.map((d) => ({ upstreamId: d.upstreamId, toolName: d.toolName })),
      actor,
    );
  }
}

export interface CreatedKeyPayload {
  id: string;
  name: string;
  prefix: string;
  /** Shown exactly once, never persisted in clear (spec §7.1). */
  secret: string;
}

export function createKeyWithAccess(input: {
  name: string;
  description?: string | null;
  scope?: "agent" | "admin";
  exposureMode?: "direct" | "discovery";
  expiresAt?: number | null;
  roleIds?: string[];
  copyFromKeyId?: string;
  grants?: Array<{ upstreamId: string; toolMode: "all" | "selected"; tools: string[]; prompts: boolean; resources: boolean }>;
  actor: string;
}): CreatedKeyPayload {
  const created = createKey({
    name: input.name,
    description: input.description ?? null,
    scope: input.scope ?? "agent",
    exposureMode: input.exposureMode ?? "direct",
    expiresAt: input.expiresAt ?? null,
    roleIds: input.roleIds ?? [],
    actor: input.actor,
  });
  for (const grant of input.grants ?? []) {
    upsertGrant(
      {
        subjectType: "key",
        subjectId: created.id,
        upstreamId: grant.upstreamId,
        toolMode: grant.toolMode,
        tools: grant.tools,
        prompts: grant.prompts,
        resources: grant.resources,
      },
      input.actor,
    );
  }
  if (input.copyFromKeyId) {
    copyAccessFromKey(input.copyFromKeyId, created.id, input.actor, true);
  }
  return created;
}

/** Full detail payload for `GET /keys/{id}`. */
export function keyDetail(keyId: string) {
  const key = getKey(keyId);
  if (!key) return null;
  const view = buildEffectiveAccessView(keyId);
  return {
    key: serializeKey(key, view),
    effective: view,
    ownGrants: ownGrantsForKey(keyId),
    denies: getDb().select().from(keyDenies).where(eq(keyDenies.keyId, keyId)).all(),
  };
}

/** Keys, roles and upstream counts for the dashboard. */
export function keyTotals() {
  const db = getDb();
  const all = db.select().from(apiKeys).all();
  const now = Date.now();
  return {
    total: all.length,
    active: all.filter((k) => k.revokedAt === null && (k.expiresAt === null || k.expiresAt > now)).length,
    revoked: all.filter((k) => k.revokedAt !== null).length,
    expired: all.filter((k) => k.revokedAt === null && k.expiresAt !== null && k.expiresAt <= now).length,
    admin: all.filter((k) => k.scope === "admin").length,
  };
}

