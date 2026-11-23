/**
 * Per-session MCP server (spec §2.1 Gateway, §6.1–§6.3, §7.3).
 *
 * One SDK `Server` is created per client session and closed over that session's state
 * (key, exposure mode, client info). Handler rules:
 *
 *   - `tools/list` is filtered by the key's *current* effective access, or replaced by the three
 *     discovery meta-tools (+ `report_feedback`) when the key is in discovery mode.
 *     `report_feedback` is always listed unless disabled in Settings (§6.5).
 *   - `tools/call` re-checks the access from the DB on EVERY call: a revoked key or a tightened
 *     grant bites mid-session (§6.2). An unauthorised call produces the exact same JSON-RPC error
 *     as an unknown tool, and is logged with `denied: true`.
 *   - prompts/resources follow the same pattern.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
  type ServerNotification,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { CatalogEntry } from "../types";
import {
  CALL_TOOL_NAME,
  DESCRIBE_TOOL_NAME,
  DISCOVERY_TOOLS,
  LIST_SERVERS_NAME,
  SEARCH_TOOLS_NAME,
  runCallTool,
  runDescribeTool,
  runListServers,
  runSearchTools,
} from "./discovery";
import {
  ADMIN_TOOLS,
  ADMIN_TOOL_NAMES,
  isAdminKey,
  runAdminTool,
} from "./adminTools";
import {
  REPORT_FEEDBACK_NAME,
  REPORT_FEEDBACK_TOOL,
  isFeedbackToolAvailable,
  runReportFeedback,
} from "./feedbackTool";
import { buildInstructions, toolsByServerForKey } from "./instructions";
import { EVENTS_METHODS } from "./events-protocol";
import { eventsAvailability, extensionsForKey, relayEvents } from "./events-relay";
import { z } from "zod";
import { SERVER_NAME, SERVER_VERSION } from "./meta";
import {
  callPublicTool,
  getPublicPrompt,
  isDiscoveryMode,
  isKeyUsableNow,
  notFoundError,
  readPublicResource,
  subscribePublicResource,
  unsubscribePublicResource,
  visiblePrompts,
  visibleResourceTemplates,
  visibleResources,
  visibleTools,
  type GatewayCallContext,
} from "./router";
import { setClientInfo, touchState, type GatewaySessionState } from "./sessions";
import { effectiveAccessForKey } from "../auth/grants";
import { getCatalogSnapshot } from "../catalog/catalog";

/** A catalog entry rendered as an MCP `Tool`, definition passed through untouched (§5). */
export function toMcpTool(entry: CatalogEntry): Tool {
  const definition = entry.definition ?? {};
  const inputSchema =
    definition.inputSchema && typeof definition.inputSchema === "object"
      ? (definition.inputSchema as Tool["inputSchema"])
      : { type: "object" as const, properties: {} };
  return {
    name: entry.publicName,
    ...(entry.description ? { description: entry.description } : {}),
    inputSchema,
    ...(definition.outputSchema ? { outputSchema: definition.outputSchema as Tool["outputSchema"] } : {}),
    ...(definition.annotations ? { annotations: definition.annotations as Tool["annotations"] } : {}),
  };
}

/** Public tool list for one key: direct tools, or discovery meta-tools (+ report_feedback). */
export function listToolsFor(
  keyId: string,
  exposureMode: string,
): { tools: Tool[]; discovery: boolean; toolCount: number } {
  // A revoked or expired key sees nothing at all, not even the gateway's own tools. The HTTP layer
  // already answers 401 and the revocation listener closes the session; this covers the window
  // where a request is still in flight (§6.1/§10).
  if (!isKeyUsableNow(keyId)) return { tools: [], discovery: false, toolCount: 0 };

  // An admin key manages upstreams; it never borrows an upstream's tools. This is the whole point
  // of the split (lib/gateway/adminTools.ts): gaining management power must not widen data access.
  if (isAdminKey(keyId)) {
    // `report_feedback` belongs to the gateway, not to an upstream, so it stays available here.
    // The admin instructions mention it: list and instructions must agree, or an agent is told
    // about a tool it cannot see.
    const adminTools: Tool[] = [...ADMIN_TOOLS];
    if (isFeedbackToolAvailable()) adminTools.push(REPORT_FEEDBACK_TOOL);
    return { tools: adminTools, discovery: false, toolCount: ADMIN_TOOLS.length };
  }

  const tools = visibleTools(keyId);
  const discovery = isDiscoveryMode(exposureMode, tools.length);
  const out: Tool[] = discovery ? [...DISCOVERY_TOOLS] : tools.map(toMcpTool);
  if (isFeedbackToolAvailable()) out.push(REPORT_FEEDBACK_TOOL);
  return { tools: out, discovery, toolCount: tools.length };
}

/** Builds the call context handed to the router (progress token + notification channel). */
function callContext(
  state: GatewaySessionState,
  extra: {
    signal: AbortSignal;
    _meta?: { progressToken?: string | number };
    sendNotification: (notification: ServerNotification) => Promise<void>;
  },
): GatewayCallContext {
  return {
    keyId: state.keyId,
    sessionId: state.sessionId,
    clientInfo: state.clientInfo,
    signal: extra.signal,
    ...(extra._meta?.progressToken !== undefined ? { progressToken: extra._meta.progressToken } : {}),
    sendNotification: extra.sendNotification,
  };
}

/**
 * Creates the MCP server for one session. The caller connects it to the session's transport and
 * registers both in lib/gateway/sessions.ts.
 */
export function createGatewayServer(state: GatewaySessionState): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        logging: {},
        // Derived from the upstreams this key can actually use — never a static list. A key with
        // no events-capable upstream gets an empty block, so a client is not told the extension
        // exists when it would answer nothing.
        ...(Object.keys(extensionsForKey(state.keyId)).length > 0
          ? { extensions: extensionsForKey(state.keyId) }
          : {}),
      },
      instructions: buildInstructionsFor(state),
    },
  );

  // --- initialize: remember who the client is (§7.1 "sessions ouvertes") ----------------
  server.oninitialized = () => {
    try {
      const info = server.getClientVersion() ?? null;
      setClientInfo(state.sessionId, info);
      state.clientInfo = info;
    } catch {
      /* client info is cosmetic */
    }
  };

  // --- events/* (MCP Events extension, SEP-3415) ----------------------------------------
  //
  // The extension is a set of extension methods, not tools: they are relayed to the upstreams
  // that speak it (lib/gateway/events-relay.ts). Registration is unconditional so a session that
  // gains an events-capable upstream mid-life (list_changed) can use it, but every handler
  // re-resolves the key's access from the DB and refuses an unreachable upstream exactly like
  // tools/call does.
  for (const method of EVENTS_METHODS) {
    server.setRequestHandler(
      z.object({ method: z.literal(method), params: z.record(z.string(), z.unknown()).optional() }),
      async (request: { params?: Record<string, unknown> }, extra) => {
        touchState(state);
        if (!isKeyUsableNow(state.keyId)) throw notFoundError("tool", method);
        return (await relayEvents(method, request.params ?? {}, callContext(state, extra))) as never;
      },
    );
  }

  // --- tools/list ----------------------------------------------------------------------
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    touchState(state);
    const { tools } = listToolsFor(state.keyId, state.exposureMode);
    return { tools };
  });

  // --- tools/call ----------------------------------------------------------------------
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    touchState(state);
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    // A revoked or expired key can call nothing at all — not even the gateway's own tools.
    // (Upstream tools are covered by the router's access check; this closes the gap for the
    // meta-tools, which belong to no upstream.)
    if (!isKeyUsableNow(state.keyId)) throw notFoundError("tool", name);

    // --- admin meta-tools ----------------------------------------------------------------
    // Re-checked per call from the DB, like every other access decision: a key demoted from
    // admin mid-session stops answering these immediately. ADMIN_TOOL_NAMES is a closed set,
    // so a non-admin key can never reach an upstream tool through this branch.
    if (ADMIN_TOOL_NAMES.includes(name)) {
      if (!isAdminKey(state.keyId)) throw notFoundError("tool", name);
      return (await runAdminTool(name, args, state.keyName)) as CallToolResult;
    }

    if (name === REPORT_FEEDBACK_NAME) {
      if (!isFeedbackToolAvailable()) throw notFoundError("tool", name);
      const result = await runReportFeedback(args, {
        keyId: state.keyId,
        sessionId: state.sessionId,
        clientInfo: state.clientInfo,
      });
      return result as CallToolResult;
    }

    if (name === LIST_SERVERS_NAME) {
      if (!isDiscoveryEnabledFor(state)) throw notFoundError("tool", name);
      return runListServers(state.keyId) as CallToolResult;
    }

    if (name === SEARCH_TOOLS_NAME) {
      if (!isDiscoveryEnabledFor(state)) throw notFoundError("tool", name);
      return runSearchTools(state.keyId, { query: args.query, limit: args.limit }) as CallToolResult;
    }

    if (name === DESCRIBE_TOOL_NAME) {
      if (!isDiscoveryEnabledFor(state)) throw notFoundError("tool", name);
      return runDescribeTool(state.keyId, { name: args.name }, isFeedbackToolAvailable()) as CallToolResult;
    }

    if (name === CALL_TOOL_NAME) {
      if (!isDiscoveryEnabledFor(state)) throw notFoundError("tool", name);
      const result = await runCallTool({ name: args.name, arguments: args.arguments }, callContext(state, extra));
      return result as CallToolResult;
    }

    // Everything else is an upstream tool: the router re-checks access from the DB.
    return callPublicTool(name, args, callContext(state, extra));
  });

  // --- prompts -------------------------------------------------------------------------
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    touchState(state);
    if (!isKeyUsableNow(state.keyId)) return { prompts: [] };
    const prompts = visiblePrompts(state.keyId).map((entry) => ({
      name: entry.publicName,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.definition?.arguments ? { arguments: entry.definition.arguments as never } : {}),
    }));
    return { prompts };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request, extra) => {
    touchState(state);
    const args = request.params.arguments as Record<string, string> | undefined;
    return getPublicPrompt(request.params.name, args, callContext(state, extra));
  });

  // --- resources -----------------------------------------------------------------------
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    touchState(state);
    if (!isKeyUsableNow(state.keyId)) return { resources: [] };
    const resources = visibleResources(state.keyId).map((entry) => ({
      uri: entry.publicName,
      name: entry.definition?.title ?? entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.definition?.mimeType ? { mimeType: entry.definition.mimeType } : {}),
    }));
    return { resources };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    touchState(state);
    if (!isKeyUsableNow(state.keyId)) return { resourceTemplates: [] };
    const resourceTemplates = visibleResourceTemplates(state.keyId).map((entry) => ({
      uriTemplate: entry.definition?.uriTemplate ?? entry.publicName,
      name: entry.definition?.title ?? entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.definition?.mimeType ? { mimeType: entry.definition.mimeType } : {}),
    }));
    return { resourceTemplates };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => {
    touchState(state);
    return readPublicResource(request.params.uri, callContext(state, extra));
  });

  server.setRequestHandler(SubscribeRequestSchema, async (request, extra) => {
    touchState(state);
    await subscribePublicResource(request.params.uri, callContext(state, extra));
    state.subscriptions.add(request.params.uri);
    return {};
  });

  server.setRequestHandler(UnsubscribeRequestSchema, async (request, extra) => {
    touchState(state);
    await unsubscribePublicResource(request.params.uri, callContext(state, extra));
    state.subscriptions.delete(request.params.uri);
    return {};
  });

  return server;
}

/** Admin keys read a short, purpose-built inventory: their tools are not upstream tools. */
const ADMIN_INSTRUCTIONS = [
  "Cette clé a la portée admin : elle sert à GÉRER les serveurs MCP du gateway, pas à appeler leurs outils.",
  "",
  "Outils de gestion (toujours disponibles) :",
  "1. upstream_list({}) — les upstreams configurés (id, slug, transport, statut, nombre d'outils).",
  "2. upstream_get({id}) — la configuration complète d'un upstream ; les secrets sont réduits à leurs noms de clés.",
  "3. upstream_create({name, transport, url|command, ...}) — ajoute un serveur MCP.",
  "   transport=http|sse exige url ; transport=stdio exige command (+ args, cwd, env).",
  "4. upstream_update({id, ...}) — modifie un upstream ; seuls les champs fournis changent.",
  "",
  "Règles à connaître :",
  "- Les secrets ne sont JAMAIS renvoyés : envKeys et headerKeys ne donnent que des noms.",
  "- env et headers sont remplacés en bloc quand tu les fournis ; omets-les pour les conserver.",
  "- Le slug doit faire 1-12 caractères [a-z0-9] ; il est dérivé du nom si tu l'omets.",
  "- Suppression, redémarrage et test de connexion ne sont pas exposés : ils restent en UI/API REST.",
  "- upstream_create renvoie tout de suite ; la connexion se fait en arrière-plan, revérifie avec upstream_get.",
  "",
  "report_feedback reste disponible pour signaler un problème à l'administrateur.",
].join("\n");

/** Instructions text for a session, built from the key's live access (§6.1). */
function buildInstructionsFor(state: GatewaySessionState): string {
  // An admin key must not be told about upstream tools it can never call.
  if (isAdminKey(state.keyId)) return ADMIN_INSTRUCTIONS;
  try {
    const access = effectiveAccessForKey(state.keyId);
    const tools = visibleTools(state.keyId);
    return buildInstructions({
      access,
      snapshot: getCatalogSnapshot(),
      discovery: isDiscoveryMode(state.exposureMode, tools.length),
      feedbackEnabled: isFeedbackToolAvailable(),
      toolCount: tools.length,
      toolsByServer: toolsByServerForKey(access),
      eventsUpstreams: eventsAvailability(state.keyId).upstreams,
    });
  } catch {
    return buildInstructions({
      access: null,
      discovery: state.exposureMode === "discovery",
      feedbackEnabled: isFeedbackToolAvailable(),
      toolCount: 0,
    });
  }
}

/** Discovery meta-tools are only routable when the key's list is actually in discovery mode. */
function isDiscoveryEnabledFor(state: GatewaySessionState): boolean {
  const tools = visibleTools(state.keyId);
  return isDiscoveryMode(state.exposureMode, tools.length);
}

/** Helper for tests/push: the tool/prompt/resource names currently visible to a key. */
export function visibleNameSets(keyId: string): { tools: string[]; prompts: string[]; resources: string[] } {
  return {
    tools: visibleTools(keyId).map((entry) => entry.publicName),
    prompts: visiblePrompts(keyId).map((entry) => entry.publicName),
    resources: visibleResources(keyId).map((entry) => entry.publicName),
  };
}
