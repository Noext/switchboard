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
 * `report_feedback` is always appended (lib/gateway/feedbackTool.ts).
 *
 * The search allow-list is the key's effective tool set; lib/catalog/discovery.ts enforces it.
 *
 * Discoverability matters as much as the access rules: an agent that cannot enumerate its surface
 * burns dozens of calls guessing keywords. That is why "no query" means "list everything", why
 * list_servers exists, and why a failed search says which servers ARE reachable.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { searchTools } from "../catalog/discovery";
import { getCatalogSnapshot } from "../catalog/catalog";
import { effectiveAccessForKey } from "../auth/grants";
import type { CatalogEntry } from "../types";
import { callPublicTool, visibleTools, type GatewayCallContext } from "./router";
import { REPORT_FEEDBACK_TOOL } from "./feedbackTool";

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

/** Servers this key may use, derived from the effective access (never from the whole catalog). */
function visibleServers(keyId: string): ServerSummary[] {
  const snapshot = getCatalogSnapshot();
  const access = effectiveAccessForKey(keyId);
  if (!access) return [];
  const out: ServerSummary[] = [];
  for (const [upstreamId, entry] of Object.entries(access.upstreams)) {
    if (!entry.hasAccess) continue;
    const view = snapshot.upstreams[upstreamId];
    if (!view) continue;
    const entries = visibleTools(keyId).filter((tool) => tool.upstreamId === upstreamId);
    out.push({
      slug: view.slug,
      name: view.name,
      description: view.description,
      toolCount: entries.length,
      tools: entries.map((tool) => tool.publicName),
    });
  }
  return out.sort((a, b) => b.toolCount - a.toolCount || a.slug.localeCompare(b.slug));
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
  const allowed: CatalogEntry[] = visibleTools(keyId);
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
  const hits = searchTools(query!, limit, allowed);

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

  // Meta-tools first: they belong to the gateway, not to an upstream.
  const metaTools: Tool[] = [...DISCOVERY_TOOLS];
  if (feedbackEnabled) metaTools.push(REPORT_FEEDBACK_TOOL);
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

/** `call_tool` — routes exactly like `tools/call`, including the access re-check. */
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
  const result = await callPublicTool(name, args, ctx);
  return result as { content: unknown[]; isError?: boolean; structuredContent?: unknown };
}
