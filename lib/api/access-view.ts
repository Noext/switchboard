import { getDb } from "../db";
import { apiKeys } from "../db/schema";
import { eq } from "drizzle-orm";
import { effectiveAccessForKey } from "../auth/grants";
import { getCatalogSnapshot } from "../catalog/catalog";
import type { EffectiveAccess, SubjectType } from "../types";

/**
 * Read models derived from the effective access computation. Shared by
 * `GET /keys/{id}/effective`, `GET /export`, `install.md` and `GET /upstreams/{id}/access`.
 */

export interface VisibleItem {
  /** Original name in the upstream (tool/prompt name, resource uri). */
  name: string;
  /** Public name exposed to MCP clients (`<slug>__<name>` or the resource URI). */
  publicName: string;
  description: string | null;
}

export interface EffectiveUpstreamView {
  upstreamId: string;
  slug: string;
  name: string;
  status: string;
  hasAccess: boolean;
  tools: VisibleItem[];
  /** null = no prompts access at all. */
  prompts: VisibleItem[] | null;
  /** null = no resources access at all. */
  resources: VisibleItem[] | null;
  removedByDeny: string[];
  disabledGlobally: string[];
  sources: Array<{ type: SubjectType; id: string; label: string }>;
}

export interface EffectiveAccessView {
  keyId: string;
  keyName: string;
  exposureMode: string;
  scope: string;
  usable: boolean;
  upstreams: EffectiveUpstreamView[];
  publicTools: string[];
  totals: { upstreams: number; tools: number; prompts: number; resources: number; estimatedTokens: number };
}

/** Rough token estimate: ~4 characters per token over the serialized tool definitions. */
function estimateTokens(entries: Array<{ definition: unknown }>): number {
  let chars = 0;
  for (const e of entries) {
    try {
      chars += JSON.stringify(e.definition ?? {}).length;
    } catch {
      /* ignore unserializable definitions */
    }
  }
  return Math.ceil(chars / 4);
}

export function buildEffectiveAccessView(keyId: string, access?: EffectiveAccess | null): EffectiveAccessView | null {
  const db = getDb();
  const key = db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).get();
  if (!key) return null;
  const effective = access ?? effectiveAccessForKey(keyId);
  if (!effective) return null;
  const snapshot = getCatalogSnapshot();

  const upstreams: EffectiveUpstreamView[] = [];
  let toolCount = 0;
  let promptCount = 0;
  let resourceCount = 0;
  let tokens = 0;

  for (const [upstreamId, entry] of Object.entries(effective.upstreams)) {
    const view = snapshot.upstreams[upstreamId];
    const slug = entry.upstreamSlug ?? view?.slug ?? upstreamId;
    const catalogTools = view?.tools ?? [];
    const byOriginal = new Map(catalogTools.map((t) => [t.name, t]));

    const tools: VisibleItem[] = entry.tools.map((name) => {
      const catalogEntry = byOriginal.get(name);
      return {
        name,
        publicName: catalogEntry?.publicName ?? `${slug}__${name}`,
        description: catalogEntry?.description ?? null,
      };
    });
    toolCount += tools.length;
    tokens += estimateTokens(tools.map((t) => ({ definition: byOriginal.get(t.name)?.definition ?? {} })));

    const prompts: VisibleItem[] | null = entry.prompts
      ? entry.prompts.map((name) => {
          const e = view?.prompts.find((p) => p.name === name);
          return { name, publicName: e?.publicName ?? `${slug}__${name}`, description: e?.description ?? null };
        })
      : null;
    if (prompts) promptCount += prompts.length;

    const resources: VisibleItem[] | null = entry.resources
      ? entry.resources.map((name) => {
          const e = view?.resources.find((r) => r.name === name);
          return { name, publicName: e?.publicName ?? name, description: e?.description ?? null };
        })
      : null;
    if (resources) resourceCount += resources.length;

    upstreams.push({
      upstreamId,
      slug,
      name: view?.name ?? slug,
      status: view?.status ?? "unknown",
      hasAccess: entry.hasAccess,
      tools,
      prompts,
      resources,
      removedByDeny: entry.removedByDeny,
      disabledGlobally: entry.disabledGlobally,
      sources: entry.sources,
    });
  }

  upstreams.sort((a, b) => a.slug.localeCompare(b.slug));

  return {
    keyId,
    keyName: key.name,
    exposureMode: key.exposureMode,
    scope: key.scope,
    usable: key.revokedAt === null && (key.expiresAt === null || key.expiresAt > Date.now()),
    upstreams,
    publicTools: effective.publicTools.slice().sort(),
    totals: {
      upstreams: upstreams.filter((u) => u.hasAccess).length,
      tools: toolCount,
      prompts: promptCount,
      resources: resourceCount,
      estimatedTokens: tokens,
    },
  };
}

/**
 * Access view of up to N keys for a single upstream — feeds the server "Accès" tab
 * (`GET /upstreams/{id}/access`).
 */
export function accessForUpstreamDetailed(upstreamId: string) {
  const db = getDb();
  const keyRows = db.select().from(apiKeys).all();
  const result: Array<{
    subjectType: "key";
    subjectId: string;
    label: string;
    status: string;
    viaRoles: string[];
    tools: string[];
    prompts: boolean;
    resources: boolean;
    removedByDeny: string[];
  }> = [];
  const roleSources = new Map<string, string[]>();
  for (const keyRow of keyRows) {
    const access = effectiveAccessForKey(keyRow.id);
    const entry = access?.upstreams[upstreamId];
    if (!entry) continue;
    const roles = entry.sources.filter((s) => s.type === "role").map((s) => s.label);
    if (roles.length) roleSources.set(keyRow.id, roles);
    result.push({
      subjectType: "key",
      subjectId: keyRow.id,
      label: keyRow.name,
      status: keyRow.revokedAt ? "revoked" : keyRow.expiresAt && keyRow.expiresAt <= Date.now() ? "expired" : "active",
      viaRoles: roles,
      tools: entry.tools,
      prompts: entry.prompts !== null,
      resources: entry.resources !== null,
      removedByDeny: entry.removedByDeny,
    });
  }
  return result.sort((a, b) => a.label.localeCompare(b.label));
}
