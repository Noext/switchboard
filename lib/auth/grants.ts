import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import {
  apiKeys,
  grantTools,
  grants,
  itemOverrides,
  keyDenies,
  keyRoles,
  roles,
  upstreamItems,
  upstreams,
} from "../db/schema";
import { computeEffectiveAccess, type AccessInput } from "./access";
import type { AccessGrant, EffectiveAccess, SubjectType, ToolMode } from "../types";
import { logEvent } from "../logs";
import { getCatalogSnapshot } from "../catalog/catalog";

export interface GrantInput {
  subjectType: SubjectType;
  subjectId: string;
  upstreamId: string;
  toolMode: ToolMode;
  tools?: string[];
  prompts?: boolean;
  resources?: boolean;
}

export interface RoleRecord {
  id: string;
  name: string;
  description: string | null;
  createdAt: number;
  keyIds: string[];
}

export function listRoles(): RoleRecord[] {
  const db = getDb();
  const roleRows = db.select().from(roles).all();
  const links = db.select().from(keyRoles).all();
  const byRole = new Map<string, string[]>();
  for (const l of links) {
    const list = byRole.get(l.roleId) ?? [];
    list.push(l.keyId);
    byRole.set(l.roleId, list);
  }
  return roleRows
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      createdAt: r.createdAt,
      keyIds: byRole.get(r.id) ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getRole(id: string): RoleRecord | null {
  return listRoles().find((r) => r.id === id) ?? null;
}

export function createRole(input: { name: string; description?: string | null; actor?: string }): RoleRecord {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.insert(roles).values({ id, name: input.name, description: input.description ?? null, createdAt: now }).run();
  logEvent({ actor: input.actor ?? "ui", type: "role.created", message: `Role "${input.name}" created`, data: { id } });
  return { id, name: input.name, description: input.description ?? null, createdAt: now, keyIds: [] };
}

export function updateRole(
  id: string,
  patch: { name?: string; description?: string | null; keyIds?: string[] },
  actor = "ui",
): void {
  const db = getDb();
  const before = getRole(id);
  if (patch.name !== undefined || patch.description !== undefined) {
    db.update(roles)
      .set({ name: patch.name, description: patch.description })
      .where(eq(roles.id, id))
      .run();
  }
  if (patch.keyIds !== undefined) {
    db.delete(keyRoles).where(eq(keyRoles.roleId, id)).run();
    for (const keyId of patch.keyIds) db.insert(keyRoles).values({ keyId, roleId: id }).onConflictDoNothing().run();
  }
  logEvent({
    actor,
    type: "role.updated",
    message: `Role "${before?.name ?? id}" updated`,
    data: { id, before, after: { ...before, ...patch } },
  });
}

export function deleteRole(id: string, actor = "ui"): void {
  const db = getDb();
  const row = db.select().from(roles).where(eq(roles.id, id)).get();
  db.delete(keyRoles).where(eq(keyRoles.roleId, id)).run();
  db.delete(grantTools).where(
    inArray(
      grantTools.grantId,
      db
        .select({ id: grants.id })
        .from(grants)
        .where(and(eq(grants.subjectType, "role"), eq(grants.subjectId, id))),
    ),
  ).run();
  db.delete(grants).where(and(eq(grants.subjectType, "role"), eq(grants.subjectId, id))).run();
  db.delete(roles).where(eq(roles.id, id)).run();
  logEvent({ actor, type: "role.deleted", message: `Role "${row?.name ?? id}" deleted`, data: { id } });
}

/** Upsert a grant (subject × upstream) exactly as the admin UI lambda does. */
export function upsertGrant(input: GrantInput, actor = "ui"): { id: string } {
  const db = getDb();
  const now = Date.now();
  const existing = db
    .select()
    .from(grants)
    .where(
      and(
        eq(grants.subjectType, input.subjectType),
        eq(grants.subjectId, input.subjectId),
        eq(grants.upstreamId, input.upstreamId),
      ),
    )
    .get();

  const id = existing?.id ?? randomUUID();
  if (existing) {
    db.update(grants)
      .set({
        toolMode: input.toolMode,
        prompts: input.prompts ?? false,
        resources: input.resources ?? false,
        updatedAt: now,
      })
      .where(eq(grants.id, id))
      .run();
    db.delete(grantTools).where(eq(grantTools.grantId, id)).run();
  } else {
    db.insert(grants)
      .values({
        id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        upstreamId: input.upstreamId,
        toolMode: input.toolMode,
        prompts: input.prompts ?? false,
        resources: input.resources ?? false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  for (const toolName of input.tools ?? []) {
    db.insert(grantTools).values({ grantId: id, toolName }).onConflictDoNothing().run();
  }
  logEvent({
    actor,
    type: "grant.upserted",
    message: `Access granted: ${input.subjectType} → ${input.upstreamId} (${input.toolMode})`,
    upstreamId: input.upstreamId,
    data: { input, grantId: id },
  });
  return { id };
}

export function deleteGrant(id: string, actor = "ui"): void {
  const db = getDb();
  db.delete(grantTools).where(eq(grantTools.grantId, id)).run();
  db.delete(grants).where(eq(grants.id, id)).run();
  logEvent({ actor, type: "grant.deleted", message: "Grant removed", data: { id } });
}

export function setKeyDenies(
  keyId: string,
  denies: Array<{ upstreamId: string; toolName: string | null }>,
  actor = "ui",
): void {
  const db = getDb();
  db.delete(keyDenies).where(eq(keyDenies.keyId, keyId)).run();
  for (const d of denies) {
    db.insert(keyDenies).values({ keyId, upstreamId: d.upstreamId, toolName: d.toolName }).run();
  }
  logEvent({ actor, type: "key.denies_updated", message: "Key removals updated", data: { keyId, denies } });
}

export function getKeyDenies(keyId: string): Array<{ upstreamId: string; toolName: string | null }> {
  const db = getDb();
  return db.select().from(keyDenies).where(eq(keyDenies.keyId, keyId)).all().map((r) => ({
    upstreamId: r.upstreamId,
    toolName: r.toolName,
  }));
}

/** Flattens DB grants into the pure AccessGrant shape. */
export function loadAccessGrants(filter: { subjectType?: SubjectType; subjectIds?: string[] }): AccessGrant[] {
  const db = getDb();
  const all = db.select().from(grants).all();
  const relevant = filter.subjectIds
    ? all.filter(
        (g) => filter.subjectType === undefined || (g.subjectType === filter.subjectType && filter.subjectIds!.includes(g.subjectId)),
      )
    : all;
  if (relevant.length === 0) return [];
  const ids = relevant.map((g) => g.id);
  const toolRows = db.select().from(grantTools).where(inArray(grantTools.grantId, ids)).all();
  const toolsByGrant = new Map<string, string[]>();
  for (const t of toolRows) {
    const list = toolsByGrant.get(t.grantId) ?? [];
    list.push(t.toolName);
    toolsByGrant.set(t.grantId, list);
  }
  const roleRows = db.select().from(roles).all();
  const roleNames = new Map(roleRows.map((r) => [r.id, r.name]));
  const keyRows = db.select().from(apiKeys).all();
  const keyNames = new Map(keyRows.map((k) => [k.id, k.name]));

  return relevant.map((g) => ({
    grantId: g.id,
    upstreamId: g.upstreamId,
    toolMode: g.toolMode,
    tools: toolsByGrant.get(g.id) ?? [],
    prompts: g.prompts,
    resources: g.resources,
    source: {
      type: g.subjectType,
      id: g.subjectId,
      label: g.subjectType === "role" ? roleNames.get(g.subjectId) ?? g.subjectId : keyNames.get(g.subjectId) ?? g.subjectId,
    },
  }));
}

/** Disabled tools per upstream, from global overrides. */
export function loadDisabledTools(): Map<string, Set<string>> {
  const db = getDb();
  const rows = db.select().from(itemOverrides).all();
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.enabled) continue;
    if (row.kind !== "tool") continue;
    const set = out.get(row.upstreamId) ?? new Set<string>();
    set.add(row.name);
    out.set(row.upstreamId, set);
  }
  return out;
}

/**
 * Full effective access for a key: reads the key, its roles, grants, denies and the
 * live catalog snapshot, then runs the pure algorithm.
 */
export function effectiveAccessForKey(keyId: string, now = Date.now()): EffectiveAccess | null {
  const db = getDb();
  const key = db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).get();
  if (!key) return null;
  const roleIds = db.select().from(keyRoles).where(eq(keyRoles.keyId, keyId)).all().map((r) => r.roleId);
  const subjectIds = [keyId, ...roleIds];
  const allGrants = loadAccessGrants({});
  const grants = allGrants.filter(
    (g) =>
      (g.source.type === "key" && g.source.id === keyId) ||
      (g.source.type === "role" && roleIds.includes(g.source.id)),
  );
  const denies = getKeyDenies(keyId);
  const snapshot = getCatalogSnapshot();
  const catalog: AccessInput["catalog"] = {};
  for (const [upstreamId, up] of Object.entries(snapshot.upstreams)) {
    catalog[upstreamId] = {
      slug: up.slug,
      status: up.status,
      tools: up.tools.map((t) => t.name),
      prompts: up.prompts.map((p) => p.name),
      resources: up.resources.map((r) => r.name),
      disabledTools: Array.from(loadDisabledTools().get(upstreamId) ?? []),
    };
  }
  return computeEffectiveAccess(
    {
      key: { id: key.id, scope: key.scope, revokedAt: key.revokedAt, expiresAt: key.expiresAt },
      roleIds,
      grants,
      denies,
      catalog,
    },
    now,
  );
}

/** Every subject (role or key) that has a grant on an upstream — for the "Accès" tab. */
export function accessForUpstream(upstreamId: string): Array<{
  subjectType: SubjectType;
  subjectId: string;
  label: string;
  toolMode: ToolMode;
  tools: string[];
  prompts: boolean;
  resources: boolean;
  grantId: string;
}> {
  return loadAccessGrants({})
    .filter((g) => g.upstreamId === upstreamId)
    .map((g) => ({
      subjectType: g.source.type,
      subjectId: g.source.id,
      label: g.source.label,
      toolMode: g.toolMode,
      tools: g.tools,
      prompts: g.prompts,
      resources: g.resources,
      grantId: g.grantId,
    }));
}

/** Access matrix data: keys/roles × upstreams. */
export function accessMatrix(): {
  upstreams: Array<{ id: string; slug: string; name: string; toolCount: number }>;
  rows: Array<{
    subjectType: SubjectType;
    subjectId: string;
    label: string;
    cells: Record<string, { kind: "all" | "selected" | "none" | "denied"; selected: number; total: number; toolNames: string[] }>;
  }>;
} {
  const db = getDb();
  const ups = db.select().from(upstreams).all();
  const snapshot = getCatalogSnapshot();
  const disabled = loadDisabledTools();
  const toolCounts = new Map<string, number>();
  for (const u of ups) {
    toolCounts.set(u.id, snapshot.upstreams[u.id]?.tools.length ?? 0);
  }
  const allGrants = loadAccessGrants({});
  const roleRows = listRoles();
  const keyRows = db.select().from(apiKeys).all();

  const buildRow = (subjectType: SubjectType, subjectId: string, label: string) => {
    const cells: Record<string, any> = {};
    for (const u of ups) {
      const g = allGrants.find((x) => x.source.type === subjectType && x.source.id === subjectId && x.upstreamId === u.id);
      const total = toolCounts.get(u.id) ?? 0;
      if (!g) {
        cells[u.id] = { kind: "none", selected: 0, total, toolNames: [] };
      } else if (g.toolMode === "all") {
        cells[u.id] = { kind: "all", selected: total, total, toolNames: [] };
      } else {
        cells[u.id] = { kind: "selected", selected: g.tools.length, total, toolNames: g.tools };
      }
    }
    return { subjectType, subjectId, label, cells };
  };

  const rows = [
    ...keyRows.map((k) => buildRow("key", k.id, k.name)),
    ...roleRows.map((r) => buildRow("role", r.id, r.name)),
  ];
  return {
    upstreams: ups.map((u) => ({ id: u.id, slug: u.slug, name: u.name, toolCount: toolCounts.get(u.id) ?? 0 })),
    rows,
  };
}

/** Tools granted to a subject on an upstream (used to prefill the access editor). */
export function grantFor(subjectType: SubjectType, subjectId: string, upstreamId: string) {
  const db = getDb();
  const g = db
    .select()
    .from(grants)
    .where(and(eq(grants.subjectType, subjectType), eq(grants.subjectId, subjectId), eq(grants.upstreamId, upstreamId)))
    .get();
  if (!g) return null;
  const tools = db.select().from(grantTools).where(eq(grantTools.grantId, g.id)).all().map((t) => t.toolName);
  return { ...g, tools };
}

/** All upstream items for the "server tools" tabs. */
export function listItems(upstreamId: string, kind?: string) {
  const db = getDb();
  const rows = db.select().from(upstreamItems).where(eq(upstreamItems.upstreamId, upstreamId)).all();
  return kind ? rows.filter((r) => r.kind === kind) : rows;
}
