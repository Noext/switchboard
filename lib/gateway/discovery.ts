/**
 * Discovery mode (spec §6.3).
 *
 * When a key is in discovery mode (explicitly, or because it sees more tools than the
 * configured threshold), `tools/list` is replaced by four meta-tools:
 *
 *   list_servers()                    the upstreams this key can use, with tool counts
 *   search_tools({query?, limit})     full-text search over AUTHORISED tools only;
 *                                     an empty query lists every authorised tool name
 *   describe_tool({name})             full inputSchema + annotations, meta-tools included
 *   call_tool({name, arguments})      same access rules as `tools/call`
 *
 * `report_feedback` is always appended (lib/gateway/feedbackTool.ts), and an admin-scoped key
 * also sees `upstream_*` (lib/gateway/adminTools.ts).
 *
 * The allow-list is what /mcp will actually EXECUTE — `callableTools()`, i.e. the key's effective
 * upstream access plus the admin tools when the key is admin. It used to be the effective tool set
 * alone, which described a smaller world than tools/call accepted: `upstream_create` ran happily
 * while `describe_tool` called it unknown and `search_tools` denied it existed. An agent that
 * trusts discovery over trial and error then concludes the tool is missing. Every path here must
 * start from `callableTools`, never from `visibleTools`.
 *
 * Discoverability matters as much as the access rules: an agent that cannot enumerate its surface
 * burns dozens of calls guessing keywords. That is why "no query" means "list everything", why
 * list_servers exists, and why a failed search says which servers ARE reachable.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { searchTools, type SearchHit } from "../catalog/discovery";
import { getCatalogSnapshot } from "../catalog/catalog";
import { effectiveAccessForKey } from "../auth/grants";
import type { CatalogEntry } from "../types";
import {
  callPublicTool,
  notFoundError,
  visibleTools,
  type GatewayCallContext,
} from "./router";
import { REPORT_FEEDBACK_TOOL } from "./feedbackTool";
import {
  ADMIN_TOOLS,
  ADMIN_TOOL_NAMES,
  adminActorForKey,
  isAdminKey,
  runAdminTool,
} from "./adminTools";

export const LIST_SERVERS_NAME = "list_servers";
export const SEARCH_TOOLS_NAME = "search_tools";
export const DESCRIBE_TOOL_NAME = "describe_tool";
export const CALL_TOOL_NAME = "call_tool";

/** Meta-tools that only exist in discovery mode. */
export const DISCOVERY_TOOL_NAMES: readonly string[] = [
  LIST_SERVERS_NAME,
  SEARCH_TOOLS_NAME,
  DESCRIBE_TOOL_NAME,
  CALL_TOOL_NAME,
];

export const LIST_SERVERS_TOOL: Tool = {
  name: LIST_SERVERS_NAME,
  title: "Lister les serveurs MCP",
  description:
    "Renvoie les serveurs MCP auxquels cette clé a accès, avec leur nom et leur nombre d'outils. " +
    "À appeler en premier pour savoir ce qui est disponible, puis search_tools({query}) " +
    "ou search_tools({}) pour la liste complète des outils.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export const SEARCH_TOOLS_TOOL: Tool = {
  name: SEARCH_TOOLS_NAME,
  title: "Rechercher un outil",
  description:
    "Recherche plein texte parmi les outils MCP auxquels cette clé a accès (nom, description, " +
    "noms de paramètres). Renvoie les noms publics, une description courte et le serveur. " +
    "SANS « query » (ou query=\"*\"), renvoie la LISTE COMPLÈTE des outils autorisés, groupée par " +
    "serveur : utilise-le pour découvrir la surface au lieu de deviner des mots-clés. " +
    "Utilise describe_tool pour le schéma complet, puis call_tool pour exécuter.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Mots-clés à rechercher (ex. « créer ticket jira »). Omets ce champ (ou passe « * ») " +
          "pour lister tous les outils autorisés.",
      },
      limit: { type: "number", description: "Nombre maximum de résultats (défaut 10, max 50 ; 500 en mode liste)." },
    },
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export const DESCRIBE_TOOL_TOOL: Tool = {
  name: DESCRIBE_TOOL_NAME,
  title: "Décrire un outil",
  description:
    "Renvoie le schéma d'entrée complet et les annotations d'un outil autorisé pour cette clé, " +
    "y compris les méta-outils list_servers / search_tools / describe_tool / call_tool / " +
    "report_feedback. À appeler avant call_tool pour connaître les arguments attendus.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Nom public de l'outil (ex. « gh__create_issue »)." },
    },
    required: ["name"],
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export const CALL_TOOL_TOOL: Tool = {
  name: CALL_TOOL_NAME,
  title: "Appeler un outil",
  description:
    "Exécute un outil autorisé pour cette clé. Mêmes règles d'accès que l'appel direct : un " +
    "outil inconnu ou non autorisé renvoie une erreur « outil inconnu ».",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Nom public de l'outil à appeler." },
      arguments: { type: "object", description: "Arguments de l'outil, tels que son schéma les décrit." },
    },
    required: ["name"],
  },
  annotations: { openWorldHint: true },
};

/** The discovery meta-tools, in the order an agent should reach for them. */
export const DISCOVERY_TOOLS: readonly Tool[] = [
  LIST_SERVERS_TOOL,
  SEARCH_TOOLS_TOOL,
  DESCRIBE_TOOL_TOOL,
  CALL_TOOL_TOOL,
];

export interface ListServersInput {
  [key: string]: unknown;
}

export interface SearchToolsInput {
  query?: unknown;
  limit?: unknown;
}

export interface DescribeToolInput {
  name: unknown;
}

export interface CallToolInput {
  name: unknown;
  arguments?: unknown;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asLimit(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

/** Values that mean "I want everything" rather than a literal keyword search. */
function isListEverything(query: string | null): boolean {
  if (!query) return true;
  const normalised = query.trim().toLowerCase();
  return normalised === "*" || normalised === "all" || normalised === "tout" || normalised === "**";
}

interface ServerSummary {
  slug: string;
  name: string;
  description: string | null;
  toolCount: number;
  tools: string[];
}

/**
 * The pseudo-server the gateway's own management tools belong to.
 *
 * Admin tools are callable on /mcp (server.ts) but they belong to no upstream, so a discovery
 * layer built only on the catalog cannot see them. That asymmetry was a real defect: an admin key
 * could call `upstream_create` while `describe_tool` answered "outil inconnu" and `search_tools`
 * said the tool did not exist. Discovery contradicted the callable surface, and the agent went
 * looking for a REST API instead of using the tool it already had.
 *
 * The rule this file now enforces: **whatever /mcp will execute must be discoverable here**.
 */
const GATEWAY_SLUG = "switchboard";
const GATEWAY_UPSTREAM_ID = "__gateway__";
const GATEWAY_NAME = "Switchboard (gestion)";
const GATEWAY_DESCRIPTION = "Gestion des serveurs MCP de la passerelle — clé admin uniquement.";

/** The management tools as catalog entries, so one code path formats/searches them like any other. */
function adminCatalogEntries(keyId: string): CatalogEntry[] {
  if (!isAdminKey(keyId)) return [];
  return ADMIN_TOOLS.map((tool) => ({
    kind: "tool" as const,
    name: tool.name,
    publicName: tool.name,
    upstreamId: GATEWAY_UPSTREAM_ID,
    upstreamSlug: GATEWAY_SLUG,
    description: tool.description,
    definition: {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
    },
    enabled: true,
  }));
}

/**
 * Everything this key can actually call: the granted upstream tools PLUS the admin management
 * tools when the key is admin-scoped. Every discovery path must start from this, not from
 * `visibleTools`, or it will describe a smaller world than /mcp accepts.
 */
export function callableTools(keyId: string): CatalogEntry[] {
  const upstream = visibleTools(keyId);
  const admin = adminCatalogEntries(keyId);
  return admin.length > 0 ? [...admin, ...upstream] : upstream;
}

/** Servers this key may use, derived from the effective access (never from the whole catalog). */
function visibleServers(keyId: string): ServerSummary[] {
  const snapshot = getCatalogSnapshot();
  const access = effectiveAccessForKey(keyId);
  const tools = visibleTools(keyId);
  const out: ServerSummary[] = [];
  if (access) {
    for (const [upstreamId, entry] of Object.entries(access.upstreams)) {
      if (!entry.hasAccess) continue;
      const view = snapshot.upstreams[upstreamId];
      if (!view) continue;
      const entries = tools.filter((tool) => tool.upstreamId === upstreamId);
      out.push({
        slug: view.slug,
        name: view.name,
        description: view.description,
        toolCount: entries.length,
        tools: entries.map((tool) => tool.publicName),
      });
    }
  }
  const admin = adminCatalogEntries(keyId);
  if (admin.length > 0) {
    out.push({
      slug: GATEWAY_SLUG,
      name: GATEWAY_NAME,
      description: GATEWAY_DESCRIPTION,
      toolCount: admin.length,
      tools: admin.map((tool) => tool.publicName),
    });
  }
  return out.sort((a, b) => b.toolCount - a.toolCount || a.slug.localeCompare(b.slug));
}

/** Substring match over the gateway's own entries; they are never in the FTS index. */
function matchGatewayEntries(query: string, entries: CatalogEntry[], limit: number): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const entry of entries) {
    const haystack = (entry.publicName + " " + (entry.description ?? "")).toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (!haystack.includes(term)) {
        score = -1;
        break;
      }
      score += entry.publicName.toLowerCase().includes(term) ? 3 : 1;
    }
    if (score < 0) continue;
    hits.push({
      name: entry.publicName,
      description: entry.description ?? "",
      upstream: entry.upstreamSlug,
      score,
    });
  }
  return hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

/** How many other upstreams exist on the gateway but are not granted to this key (names withheld). */
function otherUpstreamCount(keyId: string): number {
  const snapshot = getCatalogSnapshot();
  const access = effectiveAccessForKey(keyId);
  const all = Object.keys(snapshot.upstreams).length;
  const mine = access ? Object.values(access.upstreams).filter((entry) => entry.hasAccess).length : 0;
  return Math.max(0, all - mine);
}

/** `list_servers` — the inventory an agent needs before doing anything else. */
export function runListServers(keyId: string): ToolResult {
  const servers = visibleServers(keyId);
  const others = otherUpstreamCount(keyId);

  if (servers.length === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            "Aucun serveur MCP n'est autorisé pour cette clé, donc aucun outil n'est disponible." +
            (others > 0
              ? ` La passerelle héberge ${others} autre(s) serveur(s) auquel cette clé n'a pas accès.`
              : "") +
            " Utilise report_feedback (catégorie « access_needed ») pour demander l'accès dont tu as besoin.",
        },
      ],
      structuredContent: { servers: [], otherServers: others },
    };
  }

  const total = servers.reduce((sum, s) => sum + s.toolCount, 0);
  const lines = servers.map(
    (s) =>
      `- ${s.slug} : ${s.toolCount} outil${s.toolCount > 1 ? "s" : ""}` +
      (s.description ? ` — ${s.description}` : ""),
  );
  const footer =
    others > 0
      ? `\n${others} autre(s) serveur(s) existent sur la passerelle mais ne sont pas accessibles avec cette clé.`
      : "";

  return {
    content: [
      {
        type: "text",
        text:
          `${servers.length} serveur(s) MCP accessible(s), ${total} outil(s) au total :\n` +
          lines.join("\n") +
          footer +
          "\n\nPour la liste des outils : search_tools({}) (sans « query ») liste tous les outils autorisés. " +
          "search_tools({query}) cherche par mots-clés, describe_tool({name}) donne le schéma, " +
          "call_tool({name, arguments}) exécute.",
      },
    ],
    structuredContent: {
      servers: servers.map((s) => ({ slug: s.slug, name: s.name, toolCount: s.toolCount })),
      totalTools: total,
      otherServers: others,
    },
  };
}

/** Compact, grouped listing used when the caller asks for everything. */
function formatAllTools(servers: ServerSummary[], limit: number): { text: string; shown: number; total: number } {
  const total = servers.reduce((sum, s) => sum + s.toolCount, 0);
  const lines: string[] = [];
  let shown = 0;
  for (const server of servers) {
    if (shown >= limit) break;
    const names: string[] = [];
    for (const name of server.tools) {
      if (shown >= limit) break;
      names.push(name);
      shown++;
    }
    lines.push(`- ${server.slug} (${server.toolCount}) : ${names.join(", ")}`);
  }
  const truncated = shown < total ? `\n\n(${shown}/${total} outils affichés — augmente « limit » pour la suite.)` : "";
  return { text: lines.join("\n") + truncated, shown, total };
}

/** `search_tools` — never leaks tools the key cannot call. */
export function runSearchTools(keyId: string, input: SearchToolsInput): ToolResult {
  // `callableTools`, not `visibleTools`: what /mcp accepts is the contract discovery advertises.
  const allowed: CatalogEntry[] = callableTools(keyId);
  const servers = visibleServers(keyId);
  const others = otherUpstreamCount(keyId);

  if (allowed.length === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            "Aucun outil MCP n'est autorisé pour cette clé." +
            (others > 0
              ? ` La passerelle héberge ${others} autre(s) serveur(s) auquel cette clé n'a pas accès.`
              : "") +
            " Utilise report_feedback avec la catégorie « access_needed » pour demander l'accès dont tu as besoin.",
        },
      ],
      structuredContent: { results: [], total: 0 },
    };
  }

  const query = asString(input.query);

  // Empty / "*" / "all" => list the whole authorised surface. This is the "discover in one call"
  // path: an agent must never have to guess keywords to find out what it can do.
  if (isListEverything(query)) {
    const limit = asLimit(input.limit, 200, 500);
    const { text, shown, total } = formatAllTools(servers, limit);
    return {
      content: [
        {
          type: "text",
          text:
            `${total} outil(s) autorisé(s) sur ${servers.length} serveur(s) :\n` +
            text +
            "\n\nUtilise describe_tool({name}) pour le schéma complet, puis call_tool pour exécuter.",
        },
      ],
      structuredContent: {
        results: servers.flatMap((s) =>
          s.tools.slice(0, Math.max(0, limit)).map((name) => ({ name, upstream: s.slug })),
        ),
        total,
        shown,
        servers: servers.map((s) => ({ slug: s.slug, toolCount: s.toolCount })),
      },
    };
  }

  const limit = asLimit(input.limit, 10, 50);
  // The gateway's own entries are not in the FTS index (it is rebuilt from the catalog), so
  // they are matched directly and merged with the upstream hits.
  const gatewayHits = matchGatewayEntries(
    query!,
    allowed.filter((entry) => entry.upstreamId === GATEWAY_UPSTREAM_ID),
    limit,
  );
  const upstreamHits = searchTools(
    query!,
    Math.max(1, limit - gatewayHits.length),
    allowed.filter((entry) => entry.upstreamId !== GATEWAY_UPSTREAM_ID),
  );
  const hits = [...gatewayHits, ...upstreamHits].slice(0, limit);

  if (hits.length === 0) {
    // Distinguish "this keyword matches nothing" from "you have no access to that server".
    const reachable = servers.map((s) => `${s.slug} (${s.toolCount})`).join(", ");
    return {
      content: [
        {
          type: "text",
          text:
            `Aucun outil autorisé ne correspond à « ${query} ».\n` +
            `Serveurs accessibles avec cette clé : ${reachable}.` +
            (others > 0
              ? `\n${others} autre(s) serveur(s) existent sur la passerelle mais ne sont PAS accessibles avec cette clé : si tu cherches l'un d'eux, cette recherche ne le trouvera jamais — demande l'accès avec report_feedback (catégorie « access_needed »).`
              : "") +
            "\nPour voir la surface complète : search_tools({}) sans « query ».",
        },
      ],
      structuredContent: {
        results: [],
        matchedNothing: true,
        accessibleServers: servers.map((s) => ({ slug: s.slug, toolCount: s.toolCount })),
        inaccessibleServers: others,
      },
    };
  }

  const text = hits
    .map((hit) => `- ${hit.name} — ${hit.description || "(pas de description)"} [serveur : ${hit.upstream}]`)
    .join("\n");
  return {
    content: [
      {
        type: "text",
        text: `${hits.length} outil(s) trouvé(s) pour « ${query} » :\n${text}\n\nUtilise describe_tool({name}) pour le schéma complet, puis call_tool pour exécuter.`,
      },
    ],
    structuredContent: {
      results: hits.map((hit) => ({
        name: hit.name,
        description: hit.description,
        upstream: hit.upstream,
        score: hit.score,
      })),
    },
  };
}

/**
 * `describe_tool` — unknown and unauthorised upstream names answer identically (no existence
 * leak). The gateway's own meta-tools are describable, because they are not secrets: they are
 * always listed to the agent.
 */
export function runDescribeTool(keyId: string, input: DescribeToolInput, feedbackEnabled = true): ToolResult {
  const name = asString(input.name);
  if (!name) {
    return { content: [{ type: "text", text: "Le paramètre « name » est obligatoire." }], isError: true };
  }

  // Meta-tools first: they belong to the gateway, not to an upstream. The admin management
  // tools are appended when the key really is admin-scoped, because /mcp accepts them for
  // exactly that key — describing a smaller world than tools/call accepts is the defect this
  // guards against.
  const metaTools: Tool[] = [...DISCOVERY_TOOLS];
  if (feedbackEnabled) metaTools.push(REPORT_FEEDBACK_TOOL);
  if (isAdminKey(keyId)) metaTools.push(...ADMIN_TOOLS);
  const meta = metaTools.find((tool) => tool.name === name);
  if (meta) {
    const payload = {
      name: meta.name,
      title: meta.title ?? meta.name,
      description: meta.description ?? "",
      kind: "gateway" as const,
      inputSchema: meta.inputSchema ?? { type: "object", properties: {} },
      ...(meta.annotations !== undefined ? { annotations: meta.annotations } : {}),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
    };
  }

  const entry = visibleTools(keyId).find((candidate) => candidate.publicName === name);
  if (!entry) {
    const servers = visibleServers(keyId);
    const reachable = servers.map((s) => s.slug).join(", ") || "(aucun)";
    return {
      content: [
        {
          type: "text",
          text:
            `Outil inconnu : ${name}. Serveurs accessibles avec cette clé : ${reachable}. ` +
            "Utilise search_tools({}) pour la liste des outils autorisés.",
        },
      ],
      isError: true,
    };
  }
  const definition = entry.definition ?? {};
  const payload = {
    name: entry.publicName,
    description: entry.description ?? "",
    upstream: entry.upstreamSlug,
    inputSchema: definition.inputSchema ?? { type: "object", properties: {} },
    ...(definition.outputSchema !== undefined ? { outputSchema: definition.outputSchema } : {}),
    ...(definition.annotations !== undefined ? { annotations: definition.annotations } : {}),
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/**
 * `call_tool` — routes exactly like `tools/call`, including the access re-check.
 *
 * That includes the admin management tools: they are dispatched before the upstream router in
 * server.ts, so a call_tool that delegated straight to `callPublicTool` answered "Tool X not
 * found" for a tool the direct path executed happily. Two entry points into one surface must
 * route identically or the description ("mêmes règles d'accès qu'un appel direct") is a lie.
 */
export async function runCallTool(
  input: CallToolInput,
  ctx: GatewayCallContext,
): Promise<{ content: unknown[]; isError?: boolean; structuredContent?: unknown }> {
  const name = asString(input.name);
  if (!name) {
    throw new McpError(ErrorCode.InvalidParams, "Le paramètre « name » est obligatoire.");
  }
  const args =
    input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments)
      ? (input.arguments as Record<string, unknown>)
      : {};

  // Scope is re-read from the DB on every call, exactly like the direct path in server.ts.
  if (ADMIN_TOOL_NAMES.includes(name)) {
    if (!isAdminKey(ctx.keyId)) throw notFoundError("tool", name);
    return (await runAdminTool(name, args, adminActorForKey(ctx.keyId))) as {
      content: unknown[];
      isError?: boolean;
      structuredContent?: unknown;
    };
  }

  const result = await callPublicTool(name, args, ctx);
  return result as { content: unknown[]; isError?: boolean; structuredContent?: unknown };
}
