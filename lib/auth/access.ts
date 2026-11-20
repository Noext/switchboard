import type {
  AccessGrant,
  EffectiveAccess,
  EffectiveUpstreamAccess,
  KeyScope,
  SubjectType,
  ToolMode,
} from "../types";

/** Raw material for the pure access computation, decoupled from SQLite. */
export interface AccessInput {
  key: {
    id: string;
    scope: KeyScope;
    revokedAt: number | null;
    expiresAt: number | null;
  };
  /** Roles attached to the key. */
  roleIds: string[];
  /** Grants of the roles + the key itself, already flattened. */
  grants: AccessGrant[];
  /** Explicit removals on the key: {upstreamId, toolName|null}. */
  denies: Array<{ upstreamId: string; toolName: string | null }>;
  /** Catalogue snapshot: upstream -> {slug, status, tools, prompts, resources, disabledTools}. */
  catalog: Record<
    string,
    {
      slug: string;
      status: string;
      tools: string[];
      prompts: string[];
      resources: string[];
      /** Tools disabled globally via item_overrides. */
      disabledTools: string[];
    }
  >;
  /** Tools per upstream for "all" expansion (same as catalog.tools but explicit for tests). */
  now?: number;
}

export interface AccessCheck {
  allowed: boolean;
  upstreamSlug?: string;
  originalName?: string;
  reason?: "revoked" | "expired" | "no-access" | "not-in-selection" | "denied" | "globally-disabled" | "upstream-not-ready" | "unknown";
}

export function isKeyUsable(key: AccessInput["key"], now: number): boolean {
  if (key.revokedAt !== null && key.revokedAt <= now) return false;
  if (key.expiresAt !== null && key.expiresAt <= now) return false;
  return true;
}

/**
 * Core spec §7.3 algorithm. Pure: no I/O, deterministic, exhaustively unit-tested.
 *
 * for each upstream U:
 *   sources = grants on U from the key's roles ∪ the key's own grant
 *   no source -> no access
 *   tools = any source toolMode="all" ? all current tools : union of selected tools
 *   prompts/resources = OR of sources
 *   remove key_denies (tool-level; a deny on the whole upstream removes access)
 *   remove globally disabled tools
 *   remove upstreams that are not "ready"
 */
export function computeEffectiveAccess(input: AccessInput, now: number = Date.now()): EffectiveAccess {
  const upstreams: Record<string, EffectiveUpstreamAccess> = {};
  const publicTools: string[] = [];

  if (!isKeyUsable(input.key, now)) {
    return { keyId: input.key.id, upstreams, publicTools };
  }

  const roleSet = new Set(input.roleIds);

  // Index grants by upstream, keeping only those that apply to this key.
  const byUpstream = new Map<string, AccessGrant[]>();
  for (const grant of input.grants) {
    const applies =
      grant.source.type === "key"
        ? grant.source.id === input.key.id
        : grant.source.type === "role" && roleSet.has(grant.source.id);
    if (!applies) continue;
    const list = byUpstream.get(grant.upstreamId) ?? [];
    list.push(grant);
    byUpstream.set(grant.upstreamId, list);
  }

  // Group denies by upstream.
  const denyAll = new Set<string>();
  const denyTools = new Map<string, Set<string>>();
  for (const deny of input.denies) {
    if (deny.toolName === null) {
      denyAll.add(deny.upstreamId);
      continue;
    }
    const set = denyTools.get(deny.upstreamId) ?? new Set<string>();
    set.add(deny.toolName);
    denyTools.set(deny.upstreamId, set);
  }

  for (const [upstreamId, grants] of byUpstream) {
    const cat = input.catalog[upstreamId];
    if (!cat) continue;
    if (denyAll.has(upstreamId)) continue; // whole-upstream removal wins

    const sources = dedupeSources(grants.map((g) => g.source));
    const anyAll = grants.some((g) => g.toolMode === "all");

    const grantedToolSet = new Set<string>();
    if (anyAll) {
      for (const t of cat.tools) grantedToolSet.add(t);
    } else {
      for (const g of grants) for (const t of g.tools) grantedToolSet.add(t);
    }

    const promptsGranted = grants.some((g) => g.prompts);
    const resourcesGranted = grants.some((g) => g.resources);

    const denied = denyTools.get(upstreamId) ?? new Set<string>();
    const removedByDeny: string[] = [];
    for (const t of grantedToolSet) {
      if (denied.has(t)) removedByDeny.push(t);
    }

    const disabledSet = new Set(cat.disabledTools);
    const visibleTools: string[] = [];
    for (const t of [...grantedToolSet].sort()) {
      if (denied.has(t)) continue;
      if (disabledSet.has(t)) continue;
      visibleTools.push(t);
    }

    // Upstream not ready: hide everything but keep the access record for the UI.
    const ready = cat.status === "ready";
    const effectiveTools = ready ? visibleTools : [];

    const entry: EffectiveUpstreamAccess = {
      upstreamId,
      upstreamSlug: cat.slug,
      tools: effectiveTools,
      deniedTools: [...denied].filter((t) => t !== null),
      prompts: promptsGranted && ready ? cat.prompts : null,
      resources: resourcesGranted && ready ? cat.resources : null,
      hasAccess: effectiveTools.length > 0 || Boolean(promptsGranted) || Boolean(resourcesGranted),
      sources,
      removedByDeny: removedByDeny.sort(),
      disabledGlobally: cat.tools.filter((t) => disabledSet.has(t)),
    };

    upstreams[upstreamId] = entry;
    for (const t of effectiveTools) {
      publicTools.push(`${cat.slug}__${t}`);
    }
  }

  return { keyId: input.key.id, upstreams, publicTools };
}

function dedupeSources(sources: AccessGrant["source"][]): AccessGrant["source"][] {
  const seen = new Set<string>();
  const out: AccessGrant["source"][] = [];
  for (const s of sources) {
    const k = `${s.type}:${s.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * Checks whether a key may call/see one public tool. Mirrors the listing rules exactly so
 * an unauthorised call is indistinguishable from an unknown tool.
 */
export function checkToolAccess(
  access: EffectiveAccess,
  publicName: string,
  upstreamBySlug: Map<string, { id: string; status: string }>,
  disabledByUpstream: Map<string, Set<string>>,
): AccessCheck {
  const idx = publicName.indexOf("__");
  if (idx <= 0) return { allowed: false, reason: "unknown" };
  const slug = publicName.slice(0, idx);
  const original = publicName.slice(idx + 2);
  const upstream = upstreamBySlug.get(slug);
  if (!upstream) return { allowed: false, reason: "unknown" };

  const entry = access.upstreams[upstream.id];
  if (!entry) return { allowed: false, upstreamSlug: slug, originalName: original, reason: "no-access" };

  const disabled = disabledByUpstream.get(upstream.id);
  if (disabled?.has(original)) {
    return { allowed: false, upstreamSlug: slug, originalName: original, reason: "globally-disabled" };
  }
  if (upstream.status !== "ready") {
    return { allowed: false, upstreamSlug: slug, originalName: original, reason: "upstream-not-ready" };
  }
  if (entry.deniedTools.includes(original)) {
    return { allowed: false, upstreamSlug: slug, originalName: original, reason: "denied" };
  }
  if (!entry.tools.includes(original)) {
    return { allowed: false, upstreamSlug: slug, originalName: original, reason: "not-in-selection" };
  }
  return { allowed: true, upstreamSlug: slug, originalName: original };
}

/** True when the key's visible tool count crosses the discovery threshold. */
export function shouldUseDiscovery(exposureMode: string, visibleToolCount: number, threshold: number): boolean {
  return exposureMode === "discovery" || (exposureMode === "direct" && visibleToolCount > threshold);
}
