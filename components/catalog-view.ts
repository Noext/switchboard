import { buildPublicName, buildResourceUri } from "@/lib/catalog/naming";

/**
 * Pure catalog view builder shared by the admin UI.
 *
 * Deliberately free of `server-only` and of any DB access: it takes the rows and returns the
 * view. `components/server/catalog-db.ts` is the thin server-only wrapper that loads the rows and
 * calls this; tests import this file directly to prove the view matches the gateway's catalog.
 */

export interface CatalogToolRow {
  upstreamId: string;
  kind: string;
  name: string;
  definition: unknown;
}

export interface CatalogOverrideRow {
  upstreamId: string;
  kind: string;
  name: string;
  enabled: boolean;
  alias: string | null;
  descriptionOverride: string | null;
}

export interface CatalogUpstreamRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  enabled: boolean;
}

export interface DbCatalogTool {
  name: string;
  publicName: string;
  description: string | null;
  /** Disabled globally through an item override. */
  globallyDisabled: boolean;
}

export interface DbCatalogItem {
  name: string;
  publicName: string;
  description: string | null;
}

export interface DbCatalogUpstream {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  enabled: boolean;
  tools: DbCatalogTool[];
  prompts: DbCatalogItem[];
  resources: DbCatalogItem[];
  resourceTemplates: DbCatalogItem[];
}

function readDefinition(definition: unknown): Record<string, unknown> {
  if (definition && typeof definition === "object" && !Array.isArray(definition)) {
    return definition as Record<string, unknown>;
  }
  return {};
}

export function buildCatalogView(
  upstreamRows: CatalogUpstreamRow[],
  itemRows: CatalogToolRow[],
  overrideRows: CatalogOverrideRow[],
): DbCatalogUpstream[] {
  const overrides = new Map<string, CatalogOverrideRow>();
  for (const o of overrideRows) overrides.set(o.upstreamId + "|" + o.kind + "|" + o.name, o);

  const byUpstream = new Map<string, DbCatalogUpstream>();
  for (const u of [...upstreamRows].sort((a, b) => a.slug.localeCompare(b.slug))) {
    byUpstream.set(u.id, {
      id: u.id,
      slug: u.slug,
      name: u.name,
      description: u.description,
      status: u.status,
      enabled: u.enabled,
      tools: [],
      prompts: [],
      resources: [],
      resourceTemplates: [],
    });
  }

  // Public names are deduplicated per kind across the whole gateway, like the real catalog.
  const usedTools = new Set<string>();
  const usedPrompts = new Set<string>();

  // A resource URI held by two upstreams is rewritten to switchboard://<slug>/<uri>, exactly as
  // lib/catalog/catalog.ts does, so the UI preview cannot disagree with what MCP clients see.
  const uriCounts = new Map<string, number>();
  for (const item of itemRows) {
    if (item.kind !== "resource") continue;
    uriCounts.set(item.name, (uriCounts.get(item.name) ?? 0) + 1);
  }

  for (const item of itemRows) {
    const upstream = byUpstream.get(item.upstreamId);
    if (!upstream) continue;
    const override = overrides.get(item.upstreamId + "|" + item.kind + "|" + item.name);
    const definition = readDefinition(item.definition);
    const description =
      override?.descriptionOverride ?? (typeof definition.description === "string" ? definition.description : null);
    const enabled = override?.enabled ?? true;

    if (item.kind === "tool" || item.kind === "prompt") {
      const sourceName = override?.alias && override.alias.length > 0 ? override.alias : item.name;
      let publicName = buildPublicName(upstream.slug, sourceName).publicName;
      const used = item.kind === "tool" ? usedTools : usedPrompts;
      let suffix = 2;
      while (used.has(publicName)) {
        publicName = buildPublicName(upstream.slug, sourceName + "_" + suffix).publicName;
        suffix += 1;
      }
      used.add(publicName);
      if (item.kind === "tool") {
        upstream.tools.push({ name: item.name, publicName, description, globallyDisabled: !enabled });
      } else {
        upstream.prompts.push({ name: item.name, publicName, description });
      }
    } else if (item.kind === "resource") {
      const publicName = buildResourceUri(upstream.slug, item.name, (uriCounts.get(item.name) ?? 0) > 1);
      upstream.resources.push({ name: item.name, publicName, description });
    } else {
      const template =
        typeof definition.uriTemplate === "string" && definition.uriTemplate.length > 0
          ? definition.uriTemplate
          : item.name;
      upstream.resourceTemplates.push({ name: item.name, publicName: template, description });
    }
  }

  for (const upstream of byUpstream.values()) {
    upstream.tools.sort((a, b) => a.name.localeCompare(b.name));
    upstream.prompts.sort((a, b) => a.name.localeCompare(b.name));
    upstream.resources.sort((a, b) => a.name.localeCompare(b.name));
    upstream.resourceTemplates.sort((a, b) => a.name.localeCompare(b.name));
  }

  return Array.from(byUpstream.values());
}
