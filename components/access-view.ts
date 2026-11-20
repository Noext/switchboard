import { computeEffectiveAccess, type AccessInput } from "@/lib/auth/access";
import { buildCatalogView, type CatalogOverrideRow, type CatalogToolRow, type CatalogUpstreamRow } from "./catalog-view";
import type { AccessGrant, EffectiveAccess, SubjectType, ToolMode } from "@/lib/types";

/**
 * Pure effective-access read model for the admin UI.
 *
 * Free of `server-only` and of DB access so it can be unit-tested; `components/server/access-db.ts`
 * loads the rows and calls these helpers. The gateway computes access with the same pure
 * `computeEffectiveAccess`, so the UI preview and the real listing cannot drift.
 */

export interface GrantRow {
  id: string;
  subjectType: string;
  subjectId: string;
  upstreamId: string;
  toolMode: string;
  prompts: boolean;
  resources: boolean;
}

export interface GrantToolRow {
  grantId: string;
  toolName: string;
}

export interface DenyRow {
  upstreamId: string;
  toolName: string | null;
}

export interface SubjectName {
  id: string;
  name: string;
}

/** Catalog input for the access algorithm, built from the (fresh) upstream/item/override rows. */
export function accessCatalog(
  upstreamRows: CatalogUpstreamRow[],
  itemRows: CatalogToolRow[],
  overrideRows: CatalogOverrideRow[],
): { catalog: AccessInput["catalog"]; view: ReturnType<typeof buildCatalogView> } {
  const view = buildCatalogView(upstreamRows, itemRows, overrideRows);
  const catalog: AccessInput["catalog"] = {};
  for (const upstream of view) {
    catalog[upstream.id] = {
      slug: upstream.slug,
      status: upstream.status,
      tools: upstream.tools.filter((t) => !t.globallyDisabled).map((t) => t.name),
      prompts: upstream.prompts.map((p) => p.name),
      resources: upstream.resources.map((r) => r.name),
      disabledTools: upstream.tools.filter((t) => t.globallyDisabled).map((t) => t.name),
    };
  }
  return { catalog, view };
}

/** Flattens the grants that apply to a key (its own + those of its roles). */
export function applicableGrants(input: {
  keyId: string;
  roleIds: string[];
  grants: GrantRow[];
  grantTools: GrantToolRow[];
  roleNames: SubjectName[];
  keyNames: SubjectName[];
}): AccessGrant[] {
  const roleSet = new Set(input.roleIds);
  const relevant = input.grants.filter((g) =>
    g.subjectType === "key" ? g.subjectId === input.keyId : g.subjectType === "role" && roleSet.has(g.subjectId),
  );
  if (relevant.length === 0) return [];

  const relevantIds = new Set(relevant.map((g) => g.id));
  const toolsByGrant = new Map<string, string[]>();
  for (const t of input.grantTools) {
    if (!relevantIds.has(t.grantId)) continue;
    const list = toolsByGrant.get(t.grantId) ?? [];
    list.push(t.toolName);
    toolsByGrant.set(t.grantId, list);
  }

  const roleNames = new Map(input.roleNames.map((r) => [r.id, r.name] as const));
  const keyNames = new Map(input.keyNames.map((k) => [k.id, k.name] as const));

  return relevant.map((g) => ({
    grantId: g.id,
    upstreamId: g.upstreamId,
    toolMode: g.toolMode as ToolMode,
    tools: toolsByGrant.get(g.id) ?? [],
    prompts: g.prompts,
    resources: g.resources,
    source: {
      type: g.subjectType as SubjectType,
      id: g.subjectId,
      label:
        g.subjectType === "role" ? (roleNames.get(g.subjectId) ?? g.subjectId) : (keyNames.get(g.subjectId) ?? g.subjectId),
    },
  }));
}

/** Runs the shared pure algorithm for one key. */
export function computeAccessFor(input: {
  key: { id: string; scope: string; revokedAt: number | null; expiresAt: number | null };
  roleIds: string[];
  grants: AccessGrant[];
  denies: DenyRow[];
  catalog: AccessInput["catalog"];
  now?: number;
}): EffectiveAccess {
  return computeEffectiveAccess(
    {
      key: {
        id: input.key.id,
        scope: input.key.scope as "agent" | "admin",
        revokedAt: input.key.revokedAt,
        expiresAt: input.key.expiresAt,
      },
      roleIds: input.roleIds,
      grants: input.grants,
      denies: input.denies,
      catalog: input.catalog,
    },
    input.now ?? Date.now(),
  );
}

export interface MatrixCell {
  kind: "all" | "selected" | "none";
  selected: number;
  total: number;
  toolNames: string[];
}

export interface MatrixRow {
  subjectType: SubjectType;
  subjectId: string;
  label: string;
  cells: Record<string, MatrixCell>;
}

/** Matrix rows for keys + roles, from the grant rows (pure). */
export function buildMatrixRows(input: {
  upstreams: Array<{ id: string; slug: string; name: string; toolCount: number }>;
  keys: SubjectName[];
  roles: SubjectName[];
  grants: GrantRow[];
  grantTools: GrantToolRow[];
}): MatrixRow[] {
  const toolsByGrant = new Map<string, string[]>();
  for (const t of input.grantTools) {
    const list = toolsByGrant.get(t.grantId) ?? [];
    list.push(t.toolName);
    toolsByGrant.set(t.grantId, list);
  }
  const totalByUpstream = new Map(input.upstreams.map((u) => [u.id, u.toolCount] as const));

  const buildRow = (subjectType: SubjectType, subjectId: string, label: string): MatrixRow => {
    const cells: Record<string, MatrixCell> = {};
    for (const upstream of input.upstreams) {
      const grant = input.grants.find(
        (g) => g.subjectType === subjectType && g.subjectId === subjectId && g.upstreamId === upstream.id,
      );
      const total = totalByUpstream.get(upstream.id) ?? 0;
      if (!grant) {
        cells[upstream.id] = { kind: "none", selected: 0, total, toolNames: [] };
      } else if (grant.toolMode === "all") {
        cells[upstream.id] = { kind: "all", selected: total, total, toolNames: [] };
      } else {
        const toolNames = toolsByGrant.get(grant.id) ?? [];
        cells[upstream.id] = { kind: "selected", selected: toolNames.length, total, toolNames };
      }
    }
    return { subjectType, subjectId, label, cells };
  };

  return [
    ...input.keys.map((k) => buildRow("key", k.id, k.name)),
    ...input.roles.map((r) => buildRow("role", r.id, r.name)),
  ];
}
