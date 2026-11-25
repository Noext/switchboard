/**
 * Admin meta-tools (spec §6.6).
 *
 * A key with `scope === "admin"` used to be refused on /mcp entirely ("admin keys are for the
 * admin API and have no tool access"). That left the most common automation — "an agent adds an
 * MCP server for me" — with no path through the gateway: the agent had to speak the REST API,
 * which needs its own client and cannot be discovered by an MCP client.
 *
 * An admin key now gets a small, fixed tool surface instead of upstream tools: list, get, create
 * and update upstreams. Two invariants make this safe:
 *
 *   - An admin key never sees an upstream tool (its effective access is empty by construction),
 *     so gaining admin tools never widens access to somebody else's server.
 *   - Deletion and restart are NOT exposed. They are one-way or disruptive, and an agent that
 *     can silently delete an upstream can take the whole gateway down; they stay on the REST
 *     API and in the UI, behind a human.
 *
 * Every handler re-checks the key scope from the DB on each call, exactly like router.ts does
 * for upstream tools: a key demoted from admin mid-session loses the tools immediately.
 */

import { eq } from "drizzle-orm";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";
import { getKey } from "../auth/keys";
import { createUpstream, patchUpstream, safeManager } from "../api/upstreams";
import { upstreamById } from "../api/serialize";
import { decodeSecretMap } from "../api/secrets";
import { upstreamCreateSchema, upstreamPatchSchema } from "../api/schemas";
import { upstreams } from "../db/schema";
import { getDb } from "../db";

export const UPSTREAM_LIST_NAME = "upstream_list";
export const UPSTREAM_GET_NAME = "upstream_get";
export const UPSTREAM_CREATE_NAME = "upstream_create";
export const UPSTREAM_UPDATE_NAME = "upstream_update";

/** The complete admin tool surface. Nothing else is routable for an admin key. */
export const ADMIN_TOOL_NAMES: readonly string[] = [
  UPSTREAM_LIST_NAME,
  UPSTREAM_GET_NAME,
  UPSTREAM_CREATE_NAME,
  UPSTREAM_UPDATE_NAME,
];

/** True when this key is an admin-scope key (read from the DB, never from session state). */
export function isAdminKey(keyId: string): boolean {
  try {
    return getKey(keyId)?.scope === "admin";
  } catch {
    return false;
  }
}

/**
 * The actor string an admin tool records. Read from the DB by key id, so the direct path (which
 * has the session's key name at hand) and call_tool (which only has the key id) attribute the
 * same change to the same actor.
 */
export function adminActorForKey(keyId: string): string {
  try {
    return getKey(keyId)?.name ?? keyId;
  } catch {
    return keyId;
  }
}

export interface AdminToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const ENV_SCHEMA = {
  type: "object" as const,
  additionalProperties: { type: "string" as const },
  description: "Variables d'environnement (stdio). Chiffrées au repos, jamais renvoyées.",
};

const HEADERS_SCHEMA = {
  type: "object" as const,
  additionalProperties: { type: "string" as const },
  description: "En-têtes HTTP envoyés à l'upstream. Chiffrés au repos, jamais renvoyés.",
};

export const UPSTREAM_LIST_TOOL: Tool = {
  name: UPSTREAM_LIST_NAME,
  title: "Lister les serveurs MCP",
  description:
    "Liste les upstreams MCP configurés dans le gateway : id, slug, nom, transport, statut, " +
    "nombre d'outils. Ne renvoie jamais de secret. À appeler avant upstream_get / upstream_update.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export const UPSTREAM_GET_TOOL: Tool = {
  name: UPSTREAM_GET_NAME,
  title: "Détail d'un serveur MCP",
  description:
    "Renvoie la configuration complète d'un upstream (par id ou slug). Les secrets sont réduits " +
    "à leurs noms de clés (envKeys / headerKeys), jamais à leurs valeurs.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Identifiant de l'upstream." },
      slug: { type: "string", description: "Slug de l'upstream (alternative à id)." },
    },
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export const UPSTREAM_CREATE_TOOL: Tool = {
  name: UPSTREAM_CREATE_NAME,
  title: "Ajouter un serveur MCP",
  description:
    "Crée un upstream MCP. transport=http|sse exige url ; transport=stdio exige command.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Nom lisible (≤ 120 caractères)." },
      slug: { type: "string", description: "Slug 1-12 caractères [a-z0-9] ; dérivé du nom si omis." },
      description: { type: "string", description: "Rôle du serveur, affiché aux agents." },
      transport: { type: "string", enum: ["http", "sse", "stdio"], description: "http, sse ou stdio." },
      url: { type: "string", description: "URL du endpoint MCP (transports http/sse)." },
      command: { type: "string", description: "Commande à lancer (transport stdio)." },
      args: { type: "array", items: { type: "string" }, description: "Arguments de la commande (stdio)." },
      cwd: { type: "string", description: "Répertoire de travail du processus (stdio)." },
      env: ENV_SCHEMA,
      headers: HEADERS_SCHEMA,
      bearerToken: { type: "string", description: "Raccourci : stocké comme en-tête Authorization." },
      authType: { type: "string", enum: ["none", "headers", "bearer", "oauth"] },
      enabled: { type: "boolean", description: "Activé (défaut true)." },
      startMode: {
        type: "string",
        enum: ["always", "lazy"],
        description: "always connecte au boot ; lazy à la première utilisation (stdio).",
      },
      idleStopMinutes: { type: "number", description: "Arrêt du processus stdio lazy après inactivité (défaut 15)." },
      callTimeoutSeconds: { type: "number", description: "Délai maximum d'un appel (défaut 120)." },
    },
    required: ["name", "transport"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

export const UPSTREAM_UPDATE_TOOL: Tool = {
  name: UPSTREAM_UPDATE_NAME,
  title: "Modifier un serveur MCP",
  description:
    "Met à jour un upstream existant (par id ou slug). Seuls les champs fournis changent. " +
    "Les secrets (env, headers) sont REMPLACÉS en bloc quand ils sont fournis ; omets-les pour les conserver.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Identifiant ou slug de l'upstream à modifier." },
      name: { type: "string" },
      slug: { type: "string" },
      description: { type: "string" },
      url: { type: "string" },
      command: { type: "string" },
      args: { type: "array", items: { type: "string" } },
      cwd: { type: "string" },
      env: ENV_SCHEMA,
      headers: HEADERS_SCHEMA,
      bearerToken: { type: "string", description: "Fait tourner l'en-tête Authorization." },
      authType: { type: "string", enum: ["none", "headers", "bearer", "oauth"] },
      enabled: { type: "boolean" },
      startMode: { type: "string", enum: ["always", "lazy"] },
      idleStopMinutes: { type: "number" },
      callTimeoutSeconds: { type: "number" },
    },
    required: ["id"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

export const ADMIN_TOOLS: readonly Tool[] = [
  UPSTREAM_LIST_TOOL,
  UPSTREAM_GET_TOOL,
  UPSTREAM_CREATE_TOOL,
  UPSTREAM_UPDATE_TOOL,
];

function ok(structured: Record<string, unknown>, summary: string): AdminToolResult {
  return { content: [{ type: "text", text: summary }], structuredContent: structured };
}

/** A validation refusal must be actionable: name the field, not a stack trace. */
function fail(error: unknown): AdminToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: "Refusé : " + message }], isError: true };
}

/** Resolves an upstream by id first, then by slug. Returns null when neither matches. */
export function resolveUpstream(idOrSlug: string) {
  const byId = upstreamById(idOrSlug);
  if (byId) return byId;
  return getDb().select().from(upstreams).where(eq(upstreams.slug, idOrSlug)).get() ?? null;
}

/** Compact row for `upstream_list`; never includes secrets. */
function summarize(row: typeof upstreams.$inferSelect) {
  let toolCount = 0;
  try {
    toolCount = safeManager()?.getState(row.id)?.toolCount ?? 0;
  } catch {
    toolCount = 0;
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    transport: row.transport,
    url: row.transport === "stdio" ? null : row.url,
    command: row.transport === "stdio" ? row.command : null,
    enabled: row.enabled,
    status: row.status,
    startMode: row.startMode,
    lastError: row.lastError,
    toolCount,
  };
}

/** Secret NAMES only. A secret value must never reach an agent, even an admin one. */
function secretKeyNames(encoded: string | null): string[] {
  if (!encoded) return [];
  try {
    return Object.keys(decodeSecretMap(encoded) ?? {});
  } catch {
    return [];
  }
}

/** Turns a zod error into one actionable line naming the offending field. */
function describeZod(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length ? issue.path.join(".") + ": " + issue.message : issue.message))
    .join(" ; ");
}

function targetOf(args: Record<string, unknown>): string {
  if (typeof args.id === "string" && args.id.length > 0) return args.id;
  if (typeof args.slug === "string" && args.slug.length > 0) return args.slug;
  return "";
}

function runList(): AdminToolResult {
  const items = getDb().select().from(upstreams).all().map(summarize);
  const summary =
    items.length === 0
      ? "Aucun upstream configuré. Utilise upstream_create pour en ajouter un."
      : items
          .map((r) => "- " + r.slug + " : " + r.name + " (" + r.transport + (r.enabled ? "" : ", désactivé") + ", " + r.status + ")")
          .join("\n");
  return ok({ upstreams: items, count: items.length }, summary);
}

function runGet(args: Record<string, unknown>): AdminToolResult {
  const target = targetOf(args);
  if (!target) return fail(new Error("id or slug is required"));
  const row = resolveUpstream(target);
  if (!row) return fail(new Error("Upstream " + target + " not found"));
  const view = {
    ...summarize(row),
    args: row.args ?? null,
    cwd: row.cwd,
    authType: row.authType,
    hasEnv: Boolean(row.envEnc),
    hasHeaders: Boolean(row.headersEnc),
    hasOAuth: Boolean(row.oauthEnc),
    envKeys: secretKeyNames(row.envEnc),
    headerKeys: secretKeyNames(row.headersEnc),
    callTimeoutSeconds: row.callTimeoutSeconds,
    idleStopMinutes: row.idleStopMinutes,
    serverInfo: row.serverInfo,
    capabilities: row.capabilities,
  };
  return ok(view, "Upstream " + row.slug + " (" + row.transport + ") — statut " + row.status + ".");
}

function runCreate(args: Record<string, unknown>, actor: string): AdminToolResult {
  const parsed = upstreamCreateSchema.safeParse(args);
  if (!parsed.success) return fail(new Error(describeZod(parsed.error)));
  const { view } = createUpstream(parsed.data, "mcp:" + actor);
  const hint = view.enabled ? " La connexion est en cours ; vérifie avec upstream_get." : "";
  return ok({ upstream: view }, "Upstream " + view.slug + " créé (" + view.transport + ", " + view.status + ")." + hint);
}

function runUpdate(args: Record<string, unknown>, actor: string): AdminToolResult {
  const target = targetOf(args);
  if (!target) return fail(new Error("id or slug is required"));
  const existing = resolveUpstream(target);
  if (!existing) return fail(new Error("Upstream " + target + " not found"));

  // `id` selects the row and `slug` may also select it; neither is a field to patch here.
  const patchInput: Record<string, unknown> = { ...args };
  delete patchInput.id;
  const parsed = upstreamPatchSchema.safeParse(patchInput);
  if (!parsed.success) return fail(new Error(describeZod(parsed.error)));
  if (Object.keys(parsed.data).length === 0) return fail(new Error("Aucun champ à modifier"));

  const view = patchUpstream(existing.id, parsed.data, "mcp:" + actor);
  if (!view) return fail(new Error("Upstream " + target + " not found"));
  return ok({ upstream: view }, "Upstream " + view.slug + " mis à jour.");
}

/**
 * Runs one admin tool. `name` must be one of ADMIN_TOOL_NAMES; the caller (server.ts) has already
 * re-checked that the session key is still an admin key.
 */
export async function runAdminTool(
  name: string,
  args: Record<string, unknown>,
  actor: string,
): Promise<AdminToolResult> {
  try {
    switch (name) {
      case UPSTREAM_LIST_NAME:
        return runList();
      case UPSTREAM_GET_NAME:
        return runGet(args);
      case UPSTREAM_CREATE_NAME:
        return runCreate(args, actor);
      case UPSTREAM_UPDATE_NAME:
        return runUpdate(args, actor);
      default:
        // Identical to the router: an unauthorised tool looks like a nonexistent one.
        throw new McpError(ErrorCode.InvalidParams, "Tool " + name + " not found");
    }
  } catch (error) {
    if (error instanceof McpError) throw error;
    return fail(error);
  }
}
