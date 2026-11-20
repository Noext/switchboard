import "server-only";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { apiKeys, grantTools, grants, itemOverrides, keyRoles, roles, upstreamItems, upstreams } from "@/lib/db/schema";
import { catalogFromDb } from "./catalog-db";
import { listRoles } from "@/lib/auth/grants";
import { deniesForKey } from "./data";
import type { SubjectType, ToolMode } from "@/lib/types";

/**
 * Server-side read models for the access editor (key fiche, role fiche, server "Accès" tab,
 * matrix side panel). Everything is serialisable so client editors only receive props.
 */

export interface EditorTool {
  name: string;
  publicName: string;
  description: string | null;
  /** Disabled globally through an item override (still listed, shown with a badge). */
  globallyDisabled: boolean;
}

export interface EditorUpstream {
  id: string;
  slug: string;
  name: string;
  status: string;
  enabled: boolean;
  tools: EditorTool[];
  promptCount: number;
  resourceCount: number;
}

export interface SubjectGrantState {
  upstreamId: string;
  mode: "all" | "selected";
  tools: string[];
  prompts: boolean;
  resources: boolean;
  grantId: string;
}

export interface EditorData {
  upstreams: EditorUpstream[];
}

/** Upstreams + their tools, with the global-disabled flag folded in. */
export function editorData(): EditorData {
  // Read the catalog from the DB (see catalog-db.ts): a process-local snapshot can be stale.
  const list: EditorUpstream[] = catalogFromDb().map((upstream) => ({
    id: upstream.id,
    slug: upstream.slug,
    name: upstream.name,
    status: upstream.status,
    enabled: upstream.enabled,
    tools: upstream.tools.map((t) => ({
      name: t.name,
      publicName: t.publicName,
      description: t.description,
      globallyDisabled: t.globallyDisabled,
    })),
    promptCount: upstream.prompts.length,
    resourceCount: upstream.resources.length,
  }));

  return { upstreams: list };
}

/** Grants of one subject (key or role), one state per upstream it has a grant on. */
export function grantsForSubject(subjectType: SubjectType, subjectId: string): SubjectGrantState[] {
  const db = getDb();
  const rows = db
    .select()
    .from(grants)
    .where(and(eq(grants.subjectType, subjectType), eq(grants.subjectId, subjectId)))
    .all();
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const toolRows = db.select().from(grantTools).all().filter((t) => ids.includes(t.grantId));
  return rows.map((g) => ({
    upstreamId: g.upstreamId,
    mode: g.toolMode as ToolMode,
    tools: toolRows
      .filter((t) => t.grantId === g.id)
      .map((t) => t.toolName)
      .sort(),
    prompts: g.prompts,
    resources: g.resources,
    grantId: g.id,
  }));
}

export interface ToolOrigin {
  /** True when the key's own grant covers this tool. */
  own: boolean;
  /** Role names that grant this tool (directly or through toolMode "all"). */
  roles: string[];
}

export interface KeyOriginData {
  /** upstreamId -> toolName -> origin. */
  origins: Record<string, Record<string, ToolOrigin>>;
  denies: Array<{ upstreamId: string; toolName: string | null }>;
  roleIds: string[];
  roleNames: string[];
}

/**
 * Where each tool of each upstream comes from, for the "origine" badges on a key's rights page
 * (spec §8: badge rôle / propre / retiré). Computed from the grant table, so tools removed by a
 * deny still show their origin.
 */
export function keyOrigins(keyId: string): KeyOriginData {
  const db = getDb();
  const roleIds = db.select().from(keyRoles).where(eq(keyRoles.keyId, keyId)).all().map((r) => r.roleId);
  const roleRows = listRoles();
  const roleNameById = new Map(roleRows.map((r) => [r.id, r.name] as const));
  const ownGrants = grantsForSubject("key", keyId);
  const roleGrants: Array<{ roleId: string; state: SubjectGrantState }> = [];
  for (const roleId of roleIds) {
    for (const state of grantsForSubject("role", roleId)) roleGrants.push({ roleId, state });
  }

  const catalog = catalogFromDb();
  const toolNamesByUpstream = new Map<string, string[]>();
  for (const upstream of catalog) toolNamesByUpstream.set(upstream.id, upstream.tools.map((t) => t.name));

  const origins: Record<string, Record<string, ToolOrigin>> = {};
  const touch = (upstreamId: string, toolName: string): ToolOrigin => {
    const byTool = (origins[upstreamId] ??= {});
    return (byTool[toolName] ??= { own: false, roles: [] });
  };

  for (const state of ownGrants) {
    if (state.mode === "all") {
      for (const toolName of toolNamesByUpstream.get(state.upstreamId) ?? []) touch(state.upstreamId, toolName).own = true;
    } else {
      for (const toolName of state.tools) touch(state.upstreamId, toolName).own = true;
    }
  }

  for (const { roleId, state } of roleGrants) {
    const label = roleNameById.get(roleId) ?? roleId;
    if (state.mode === "all") {
      for (const toolName of toolNamesByUpstream.get(state.upstreamId) ?? []) {
        const origin = touch(state.upstreamId, toolName);
        if (!origin.roles.includes(label)) origin.roles.push(label);
      }
    } else {
      for (const toolName of state.tools) {
        const origin = touch(state.upstreamId, toolName);
        if (!origin.roles.includes(label)) origin.roles.push(label);
      }
    }
  }

  return {
    origins,
    denies: deniesForKey(keyId),
    roleIds,
    roleNames: roleIds.map((id) => roleNameById.get(id) ?? id).sort(),
  };
}

/** Number of tools an upstream currently exposes (for "n/total" cells). */
export function toolCountsByUpstream(): Record<string, number> {
  const db = getDb();
  const out: Record<string, number> = {};
  for (const row of db.select().from(upstreamItems).all()) {
    if (row.kind !== "tool") continue;
    out[row.upstreamId] = (out[row.upstreamId] ?? 0) + 1;
  }
  return out;
}

export interface SubjectListEntry {
  id: string;
  name: string;
  description: string | null;
  type: SubjectType;
}

/** Active keys and roles, for the checkbox lists in access forms. */
export function subjectChoices(): { keys: SubjectListEntry[]; roles: SubjectListEntry[] } {
  const db = getDb();
  const keys = db
    .select({ id: apiKeys.id, name: apiKeys.name, description: apiKeys.description, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .all()
    .filter((k) => !k.revokedAt)
    .map((k) => ({ id: k.id, name: k.name, description: k.description, type: "key" as SubjectType }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const rolesList = db
    .select({ id: roles.id, name: roles.name, description: roles.description })
    .from(roles)
    .all()
    .map((r) => ({ id: r.id, name: r.name, description: r.description, type: "role" as SubjectType }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { keys, roles: rolesList };
}