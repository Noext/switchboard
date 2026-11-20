import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { upstreams } from "../db/schema";
import { getRedactor } from "../redact";
import { emitUiEvent } from "../events";
import { logEvent } from "../logs";
import { invalidateCatalog } from "../catalog/catalog";
import { isValidSlug, slugify } from "../catalog/naming";
import { upsertGrant } from "../auth/grants";
import { getUpstreamManager, hasUpstreamManager, type UpstreamManager } from "../upstreams/types";
import type { z } from "zod";
import type { upstreamCreateSchema, upstreamPatchSchema, accessSectionSchema } from "./schemas";
import { decodeSecretMap, encodeSecret } from "./secrets";
import { serializeUpstream, deleteUpstreamCascade, upstreamById, type UpstreamView } from "./serialize";

/** The manager is only present in the running app, never in unit tests. */
export function safeManager(): UpstreamManager | null {
  if (!hasUpstreamManager()) return null;
  try {
    return getUpstreamManager();
  } catch {
    return null;
  }
}

/** Returns a slug that is not used yet, deriving a valid one from the name when needed. */
export function uniqueSlug(desired: string | undefined, name: string, excludeId?: string): string {
  const db = getDb();
  const taken = new Set(
    db
      .select({ slug: upstreams.slug, id: upstreams.id })
      .from(upstreams)
      .all()
      .filter((r) => r.id !== excludeId)
      .map((r) => r.slug),
  );
  const base = isValidSlug(desired ?? "") ? (desired as string) : slugify(name) || "srv";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base.slice(0, 12 - String(i).length)}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("Could not derive a unique slug");
}

/** Merges a bearer token into the headers map so a single encrypted column holds everything. */
export function mergeHeaders(
  headers: Record<string, string> | null | undefined,
  bearerToken: string | null | undefined,
): Record<string, string> | null {
  const merged: Record<string, string> = { ...(headers ?? {}) };
  if (bearerToken) merged.Authorization = `Bearer ${bearerToken}`;
  return Object.keys(merged).length ? merged : null;
}

function registerSecrets(env: Record<string, string> | null, headers: Record<string, string> | null): void {
  getRedactor().registerRecord(env);
  getRedactor().registerRecord(headers);
}

/** Applies the §7.4 "Accès" section of the create form as grants. */
export function applyAccessSection(
  upstreamId: string,
  section: z.infer<typeof accessSectionSchema> | undefined,
  actor: string,
): void {
  if (!section) return;
  for (const subject of section.subjects) {
    upsertGrant(
      {
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        upstreamId,
        toolMode: subject.toolMode,
        tools: subject.tools,
        prompts: subject.prompts ?? section.prompts ?? false,
        resources: subject.resources ?? section.resources ?? false,
      },
      actor,
    );
  }
}

export interface CreateResult {
  view: UpstreamView;
  /** Granted subjects, for the response payload. */
  grants: number;
}

export function createUpstream(
  input: z.infer<typeof upstreamCreateSchema>,
  actor: string,
): CreateResult {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  const slug = uniqueSlug(input.slug, input.name);
  const env = input.env ?? null;
  const headers = mergeHeaders(input.headers, input.bearerToken);
  registerSecrets(env, headers);

  db.insert(upstreams)
    .values({
      id,
      slug,
      name: input.name,
      description: input.description ?? null,
      transport: input.transport,
      url: input.transport === "stdio" ? null : (input.url ?? null),
      command: input.transport === "stdio" ? (input.command ?? null) : null,
      args: input.transport === "stdio" ? (input.args ?? null) : null,
      cwd: input.transport === "stdio" ? (input.cwd ?? null) : null,
      envEnc: env ? encodeSecret(env) : null,
      headersEnc: headers ? encodeSecret(headers) : null,
      authType: input.authType,
      oauthEnc: input.oauth ? encodeSecret(input.oauth) : null,
      enabled: input.enabled,
      startMode: input.startMode,
      idleStopMinutes: input.idleStopMinutes,
      callTimeoutSeconds: input.callTimeoutSeconds,
      status: input.enabled ? "connecting" : "disabled",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  applyAccessSection(id, input.access, actor);

  logEvent({
    actor,
    type: "upstream.created",
    message: `Upstream "${input.name}" (${slug}) created`,
    upstreamId: id,
    data: { id, slug, transport: input.transport, authType: input.authType },
  });
  invalidateCatalog("upstream-created");
  emitUiEvent("upstream.status", { upstreamId: id, status: input.enabled ? "connecting" : "disabled" });
  emitUiEvent("catalog.changed", { reason: "upstream-created", upstreamId: id });

  const manager = safeManager();
  if (manager && input.enabled) {
    void manager.reload(id).catch(() => {
      /* the manager records the failure on the upstream status itself */
    });
  }

  const row = upstreamById(id);
  if (!row) throw new Error("upstream insert failed");
  return { view: serializeUpstream(row), grants: input.access?.subjects.length ?? 0 };
}

export function patchUpstream(
  id: string,
  patch: z.infer<typeof upstreamPatchSchema>,
  actor: string,
): UpstreamView | null {
  const db = getDb();
  const existing = upstreamById(id);
  if (!existing) return null;
  const now = Date.now();

  const set: Partial<typeof upstreams.$inferInsert> = { updatedAt: now };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.description !== undefined) set.description = patch.description ?? null;
  if (patch.url !== undefined) set.url = patch.url ?? null;
  if (patch.command !== undefined) set.command = patch.command ?? null;
  if (patch.args !== undefined) set.args = patch.args ?? null;
  if (patch.cwd !== undefined) set.cwd = patch.cwd ?? null;
  if (patch.authType !== undefined) set.authType = patch.authType;
  if (patch.enabled !== undefined) {
    set.enabled = patch.enabled;
    set.status = patch.enabled ? "connecting" : "disabled";
    if (!patch.enabled) set.lastError = null;
  }
  if (patch.startMode !== undefined) set.startMode = patch.startMode;
  if (patch.idleStopMinutes !== undefined) set.idleStopMinutes = patch.idleStopMinutes;
  if (patch.callTimeoutSeconds !== undefined) set.callTimeoutSeconds = patch.callTimeoutSeconds;
  if (patch.slug !== undefined) set.slug = uniqueSlug(patch.slug, patch.name ?? existing.name, id);

  // Secrets: only replaced when explicitly present, never echoed back.
  if (patch.env !== undefined) {
    const env = patch.env ?? null;
    registerSecrets(env, null);
    set.envEnc = env ? encodeSecret(env) : null;
  }
  if (patch.headers !== undefined || patch.bearerToken !== undefined) {
    // `headers` replaces the whole map; a bare `bearerToken` only rotates the Authorization
    // header and keeps the other headers the upstream already had.
    const base =
      patch.headers !== undefined
        ? (patch.headers ?? {})
        : { ...(decodeSecretMap(existing.headersEnc) ?? {}) };
    if (patch.bearerToken === null) delete base.Authorization;
    const headers = mergeHeaders(base, patch.bearerToken);
    registerSecrets(null, headers);
    set.headersEnc = headers ? encodeSecret(headers) : null;
    if (patch.authType === undefined && headers) set.authType = headers.Authorization ? "bearer" : "headers";
  }
  if (patch.oauth !== undefined) {
    set.oauthEnc = patch.oauth ? encodeSecret(patch.oauth) : null;
  }

  db.update(upstreams).set(set).where(eq(upstreams.id, id)).run();

  logEvent({
    actor,
    type: "upstream.updated",
    message: `Upstream "${set.name ?? existing.name}" updated`,
    upstreamId: id,
    data: {
      id,
      before: { name: existing.name, slug: existing.slug, url: existing.url, enabled: existing.enabled },
      after: { name: set.name, slug: set.slug, url: set.url, enabled: set.enabled },
      changed: Object.keys(set).filter((k) => k !== "updatedAt"),
    },
  });
  invalidateCatalog("upstream-updated");
  emitUiEvent("upstream.status", { upstreamId: id, status: set.status ?? existing.status });
  emitUiEvent("catalog.changed", { reason: "upstream-updated", upstreamId: id });

  const manager = safeManager();
  if (manager && (set.enabled ?? existing.enabled)) {
    void manager.reload(id).catch(() => {
      /* status is written back by the manager */
    });
  } else if (manager && set.enabled === false) {
    void manager.disconnect(id).catch(() => {});
  }

  const row = upstreamById(id);
  return row ? serializeUpstream(row) : null;
}

export async function removeUpstream(id: string, actor: string): Promise<boolean> {
  const existing = upstreamById(id);
  if (!existing) return false;
  const manager = safeManager();
  if (manager) {
    try {
      await manager.remove(id);
    } catch {
      /* removing the runtime must not block deleting the config */
    }
  }
  deleteUpstreamCascade(id);
  getDb().delete(upstreams).where(eq(upstreams.id, id)).run();
  logEvent({
    actor,
    type: "upstream.deleted",
    message: `Upstream "${existing.name}" (${existing.slug}) deleted`,
    upstreamId: id,
    data: { id, slug: existing.slug },
  });
  invalidateCatalog("upstream-deleted");
  emitUiEvent("catalog.changed", { reason: "upstream-deleted", upstreamId: id });
  return true;
}
