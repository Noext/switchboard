import { randomUUID } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { getDb } from "../db";
import { apiKeys, grantTools, grants, keyDenies, keyRoles } from "../db/schema";
import { constantTimeEqual, randomBase62, sha256 } from "../crypto";
import { logEvent, logger } from "../logs";

export const KEY_PREFIX = "sk-sw-";
const SECRET_LENGTH = 32;

/**
 * Key lifecycle notifications.
 *
 * The auth layer must not import the gateway (dependency direction), but spec §6.1 requires
 * that revoking a key closes its live MCP sessions immediately, and that rotating a secret or
 * changing a key's roles/exposure pushes `list_changed` to affected sessions. The gateway
 * subscribes here at boot; the auth layer only publishes.
 */
export type KeyLifecycleEvent =
  | { type: "revoked"; keyId: string }
  | { type: "rotated"; keyId: string }
  | { type: "updated"; keyId: string; affectsAccess: boolean };

export type KeyLifecycleListener = (event: KeyLifecycleEvent) => void;

const lifecycleListeners = new Set<KeyLifecycleListener>();

/** Subscribes to key lifecycle events. Returns an unsubscribe function. */
export function onKeyLifecycle(listener: KeyLifecycleListener): () => void {
  lifecycleListeners.add(listener);
  return () => lifecycleListeners.delete(listener);
}

function notifyKeyLifecycle(event: KeyLifecycleEvent): void {
  for (const listener of lifecycleListeners) {
    try {
      listener(event);
    } catch (error) {
      // A broken subscriber must never break key management.
      logger.error({ err: error, event }, 'key lifecycle listener failed');
    }
  }
}

/** Test helper: drops every subscriber. */
export function clearKeyLifecycleListeners(): void {
  lifecycleListeners.clear();
}


export interface CreatedKey {
  id: string;
  name: string;
  prefix: string;
  /** Full secret — shown once, never persisted in clear. */
  secret: string;
}

export interface KeyRecord {
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
  roleIds: string[];
}

export function generateSecret(): string {
  return KEY_PREFIX + randomBase62(SECRET_LENGTH);
}

export function keyPrefix(secret: string): string {
  return secret.slice(0, 12);
}

export function createKey(input: {
  name: string;
  description?: string | null;
  scope?: "agent" | "admin";
  exposureMode?: "direct" | "discovery";
  expiresAt?: number | null;
  roleIds?: string[];
  actor?: string;
}): CreatedKey {
  const db = getDb();
  const id = randomUUID();
  const secret = generateSecret();
  const now = Date.now();
  db.insert(apiKeys)
    .values({
      id,
      name: input.name,
      description: input.description ?? null,
      prefix: keyPrefix(secret),
      hash: sha256(secret),
      scope: input.scope ?? "agent",
      exposureMode: input.exposureMode ?? "direct",
      expiresAt: input.expiresAt ?? null,
      createdAt: now,
    })
    .run();
  for (const roleId of input.roleIds ?? []) {
    db.insert(keyRoles).values({ keyId: id, roleId }).onConflictDoNothing().run();
  }
  logEvent({
    actor: input.actor ?? "ui",
    type: "key.created",
    message: `API key "${input.name}" created`,
    data: { id, name: input.name, scope: input.scope ?? "agent", roleIds: input.roleIds ?? [] },
  });
  return { id, name: input.name, prefix: keyPrefix(secret), secret };
}

export function roleIdsForKey(keyId: string): string[] {
  const db = getDb();
  return db.select().from(keyRoles).where(eq(keyRoles.keyId, keyId)).all().map((r) => r.roleId);
}

export function getKey(id: string): KeyRecord | null {
  const db = getDb();
  const row = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  if (!row) return null;
  return toRecord(row, roleIdsForKey(id));
}

export function listKeys(): KeyRecord[] {
  const db = getDb();
  const rows = db.select().from(apiKeys).all();
  const links = db.select().from(keyRoles).all();
  const byKey = new Map<string, string[]>();
  for (const l of links) {
    const list = byKey.get(l.keyId) ?? [];
    list.push(l.roleId);
    byKey.set(l.keyId, list);
  }
  return rows
    .map((r) => toRecord(r, byKey.get(r.id) ?? []))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function toRecord(row: typeof apiKeys.$inferSelect, roleIds: string[]): KeyRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    prefix: row.prefix,
    scope: row.scope,
    exposureMode: row.exposureMode,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    rotatedAt: row.rotatedAt,
    roleIds,
  };
}

export type KeyAuthResult =
  | { ok: true; key: KeyRecord; via: "current" | "previous" }
  | { ok: false; reason: "missing" | "invalid" | "revoked" | "expired" };

/** Cache of hash -> key id, TTL 5s (spec §10). */
const hashCache = new Map<string, { keyId: string; expiresAt: number; via: "current" | "previous" }>();
const HASH_CACHE_TTL = 5000;

export function authenticateSecret(secret: string): KeyAuthResult {
  if (!secret || !secret.startsWith(KEY_PREFIX)) return { ok: false, reason: "invalid" };
  const hash = sha256(secret);

  const cached = hashCache.get(hash);
  if (cached && cached.expiresAt > Date.now()) {
    const key = getKey(cached.keyId);
    if (!key) return { ok: false, reason: "invalid" };
    if (key.revokedAt !== null) return { ok: false, reason: "revoked" };
    if (key.expiresAt !== null && key.expiresAt <= Date.now()) return { ok: false, reason: "expired" };
    touchLastUsed(key.id);
    return { ok: true, key, via: cached.via };
  }

  const db = getDb();
  const now = Date.now();
  const rows = db
    .select()
    .from(apiKeys)
    .where(or(eq(apiKeys.hash, hash), eq(apiKeys.prevHash, hash)))
    .all();

  const match = rows.find(
    (r) =>
      constantTimeEqual(r.hash, hash) ||
      (r.prevHash !== null &&
        r.prevHashExpiresAt !== null &&
        r.prevHashExpiresAt > now &&
        constantTimeEqual(r.prevHash, hash)),
  );

  if (!match) return { ok: false, reason: "invalid" };
  const via: "current" | "previous" = constantTimeEqual(match.hash, hash) ? "current" : "previous";
  if (match.revokedAt !== null) return { ok: false, reason: "revoked" };
  if (match.expiresAt !== null && match.expiresAt <= now) return { ok: false, reason: "expired" };

  hashCache.set(hash, { keyId: match.id, expiresAt: now + HASH_CACHE_TTL, via });
  touchLastUsed(match.id);
  return { ok: true, key: toRecord(match, roleIdsForKey(match.id)), via };
}

let lastTouch = new Map<string, number>();
function touchLastUsed(keyId: string): void {
  const now = Date.now();
  const prev = lastTouch.get(keyId) ?? 0;
  if (now - prev < 60_000) return; // throttle writes
  lastTouch.set(keyId, now);
  try {
    getDb().update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, keyId)).run();
  } catch {
    /* non-fatal */
  }
}

export function revokeKey(id: string, actor = "ui"): void {
  getDb().update(apiKeys).set({ revokedAt: Date.now() }).where(eq(apiKeys.id, id)).run();
  invalidateKeyCache();
  logEvent({ actor, type: "key.revoked", message: `API key revoked`, data: { id } });
  notifyKeyLifecycle({ type: "revoked", keyId: id });
}

/** Rotates the secret. graceSeconds keeps the old value valid for a limited time. */
export function rotateKey(id: string, graceSeconds: number, actor = "ui"): { secret: string } {
  const db = getDb();
  const row = db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  if (!row) throw new Error("key not found");
  const secret = generateSecret();
  const now = Date.now();
  const graceMs = Math.max(0, graceSeconds) * 1000;
  db.update(apiKeys)
    .set({
      prevHash: graceMs > 0 ? row.hash : null,
      prevHashExpiresAt: graceMs > 0 ? now + graceMs : null,
      hash: sha256(secret),
      prefix: keyPrefix(secret),
      rotatedAt: now,
    })
    .where(eq(apiKeys.id, id))
    .run();
  invalidateKeyCache();
  logEvent({
    actor,
    type: "key.rotated",
    message: `API key secret rotated (grace ${graceSeconds}s)`,
    data: { id, graceSeconds },
  });
  notifyKeyLifecycle({ type: "rotated", keyId: id });
  return { secret };
}

export function updateKey(
  id: string,
  patch: {
    name?: string;
    description?: string | null;
    exposureMode?: "direct" | "discovery";
    expiresAt?: number | null;
    roleIds?: string[];
  },
  actor = "ui",
): void {
  const db = getDb();
  const before = getKey(id);
  const set: Partial<typeof apiKeys.$inferInsert> = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.exposureMode !== undefined) set.exposureMode = patch.exposureMode;
  if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
  if (Object.keys(set).length) db.update(apiKeys).set(set).where(eq(apiKeys.id, id)).run();
  if (patch.roleIds !== undefined) {
    db.delete(keyRoles).where(eq(keyRoles.keyId, id)).run();
    for (const roleId of patch.roleIds) db.insert(keyRoles).values({ keyId: id, roleId }).onConflictDoNothing().run();
  }
  invalidateKeyCache();
  logEvent({
    actor,
    type: "key.updated",
    message: `API key "${before?.name ?? id}" updated`,
    data: { id, before, after: { ...before, ...patch } },
  });
  notifyKeyLifecycle({
    type: "updated",
    keyId: id,
    affectsAccess: patch.exposureMode !== undefined || patch.roleIds !== undefined,
  });
}

export function duplicateKey(id: string, name: string, actor = "ui"): CreatedKey {
  const source = getKey(id);
  if (!source) throw new Error("key not found");
  const db = getDb();
  const created = createKey({
    name,
    description: source.description,
    scope: source.scope,
    exposureMode: source.exposureMode,
    expiresAt: source.expiresAt,
    roleIds: source.roleIds,
    actor,
  });
  // Copy own grants and denies.
  const ownGrants = db.select().from(grants).where(and(eq(grants.subjectType, "key"), eq(grants.subjectId, id))).all();
  for (const g of ownGrants) {
    const newId = randomUUID();
    db.insert(grants)
      .values({
        id: newId,
        subjectType: "key",
        subjectId: created.id,
        upstreamId: g.upstreamId,
        toolMode: g.toolMode,
        prompts: g.prompts,
        resources: g.resources,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    const tools = db.select().from(grantTools).where(eq(grantTools.grantId, g.id)).all();
    for (const t of tools) db.insert(grantTools).values({ grantId: newId, toolName: t.toolName }).run();
  }
  const denies = db.select().from(keyDenies).where(eq(keyDenies.keyId, id)).all();
  for (const d of denies) {
    db.insert(keyDenies).values({ keyId: created.id, upstreamId: d.upstreamId, toolName: d.toolName }).run();
  }
  return created;
}

export function invalidateKeyCache(): void {
  hashCache.clear();
}

export function keysByIds(ids: string[]): KeyRecord[] {
  if (!ids.length) return [];
  const db = getDb();
  return db.select().from(apiKeys).where(inArray(apiKeys.id, ids)).all().map((r) => toRecord(r, roleIdsForKey(r.id)));
}
