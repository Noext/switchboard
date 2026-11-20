/**
 * Gateway routing layer (spec §6.2, §7.3).
 *
 * Everything that leaves the gateway towards an upstream goes through here:
 *   - resolve the public name back to `<upstream, original name>` via the catalog,
 *   - re-check the effective access **on every call** (never trust what was listed earlier),
 *   - call the UpstreamManager with timeout / cancellation / progress relaying,
 *   - write a `call_logs` row (including `denied: true` rows for refused calls).
 *
 * Security rule (spec §10): an unauthorised call and an unknown call return the exact same
 * JSON-RPC error, and neither the listing nor the error reveals that the tool exists.
 */

import { eq } from "drizzle-orm";
import type {
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { checkToolAccess, isKeyUsable, shouldUseDiscovery } from "../auth/access";
import { getKey } from "../auth/keys";
import { effectiveAccessForKey, loadDisabledTools } from "../auth/grants";
import {
  getCatalogSnapshot,
  resolvePublicPrompt,
  resolvePublicResource,
  resolvePublicTool,
  type CatalogSnapshot,
} from "../catalog/catalog";
import { parseResourceUri } from "../catalog/naming";
import { config } from "../config";
import { getDb } from "../db";
import { upstreams } from "../db/schema";
import { emitUiEvent } from "../events";
import { logCall } from "../logs";
import { getSettings } from "../settings";
import type { CatalogEntry, EffectiveAccess } from "../types";
import { getUpstreamManager, hasUpstreamManager } from "../upstreams/types";

// ---------------------------------------------------------------------------------------------
// Errors: unknown and unauthorised are indistinguishable (spec §6.2/§10).
// ---------------------------------------------------------------------------------------------

export type RoutableKind = "tool" | "prompt" | "resource";

export function notFoundError(kind: RoutableKind, name: string): McpError {
  const label = kind === "tool" ? "Tool" : kind === "prompt" ? "Prompt" : "Resource";
  return new McpError(ErrorCode.InvalidParams, `${label} ${name} not found`);
}

/** Context every routed operation needs; built by the MCP request handlers. */
export interface GatewayCallContext {
  keyId: string;
  sessionId: string;
  clientInfo?: { name?: string; version?: string } | null;
  signal?: AbortSignal;
  progressToken?: string | number;
  sendNotification?: (notification: ServerNotification) => Promise<void>;
}

// ---------------------------------------------------------------------------------------------
// Access + catalog views
// ---------------------------------------------------------------------------------------------

/**
 * Whether the key is still usable (not revoked, not expired). Revocation closes sessions
 * (lib/gateway/push.ts) but a handler may still run concurrently, so every listing checks this
 * too: a dead key must see nothing — not even `report_feedback`.
 */
export function isKeyUsableNow(keyId: string, now = Date.now()): boolean {
  try {
    const key = getKey(keyId);
    if (!key) return false;
    return isKeyUsable({ id: key.id, scope: key.scope, revokedAt: key.revokedAt, expiresAt: key.expiresAt }, now);
  } catch {
    return false;
  }
}

export interface SessionAccess {
  access: EffectiveAccess;
  snapshot: CatalogSnapshot;
  upstreamBySlug: Map<string, { id: string; status: string }>;
  disabledByUpstream: Map<string, Set<string>>;
}

function buildUpstreamBySlug(snapshot: CatalogSnapshot): Map<string, { id: string; status: string }> {
  const map = new Map<string, { id: string; status: string }>();
  for (const view of Object.values(snapshot.upstreams)) {
    map.set(view.slug, { id: view.upstreamId, status: view.status });
  }
  return map;
}

/** Reads the effective access from the DB — the single source of truth for every call. */
export function loadSessionAccess(keyId: string, snapshot: CatalogSnapshot = getCatalogSnapshot()): SessionAccess | null {
  const access = effectiveAccessForKey(keyId);
  if (!access) return null;
  return {
    access,
    snapshot,
    upstreamBySlug: buildUpstreamBySlug(snapshot),
    disabledByUpstream: loadDisabledTools(),
  };
}

function entriesFor(
  snapshot: CatalogSnapshot,
  access: EffectiveAccess,
  kind: "tool" | "prompt" | "resource" | "resource_template",
): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const [upstreamId, entry] of Object.entries(access.upstreams)) {
    const view = snapshot.upstreams[upstreamId];
    if (!view) continue;
    if (kind === "tool") {
      for (const original of entry.tools) {
        const publicName = view.toolPublicNames.get(original);
        const found = publicName ? snapshot.toolsByPublicName.get(publicName) : null;
        if (found && found.entry.enabled) out.push(found.entry);
      }
    } else if (kind === "prompt") {
      if (!entry.prompts) continue;
      for (const original of entry.prompts) {
        const publicName = view.promptPublicNames.get(original);
        const found = publicName ? snapshot.promptsByPublicName.get(publicName) : null;
        if (found && found.entry.enabled) out.push(found.entry);
      }
    } else if (kind === "resource") {
      if (!entry.resources) continue;
      for (const original of entry.resources) {
        const publicUri = view.resourcePublicUris.get(original);
        const found = publicUri ? snapshot.resourcesByPublicUri.get(publicUri) : null;
        if (found && found.entry.enabled) out.push(found.entry);
      }
    } else {
      // v1: resource templates follow the "resources" switch of the grant (spec §7.3).
      if (!entry.resources) continue;
      for (const template of view.resourceTemplates) if (template.enabled) out.push(template);
    }
  }
  return out.sort((a, b) => a.publicName.localeCompare(b.publicName));
}

/** Tools the key may see right now (live DB + live catalog). */
export function visibleTools(keyId: string): CatalogEntry[] {
  const snapshot = getCatalogSnapshot();
  const access = effectiveAccessForKey(keyId);
  if (!access) return [];
  return entriesFor(snapshot, access, "tool");
}

export function visiblePrompts(keyId: string): CatalogEntry[] {
  const snapshot = getCatalogSnapshot();
  const access = effectiveAccessForKey(keyId);
  if (!access) return [];
  return entriesFor(snapshot, access, "prompt");
}

export function visibleResources(keyId: string): CatalogEntry[] {
  const snapshot = getCatalogSnapshot();
  const access = effectiveAccessForKey(keyId);
  if (!access) return [];
  return entriesFor(snapshot, access, "resource");
}

export function visibleResourceTemplates(keyId: string): CatalogEntry[] {
  const snapshot = getCatalogSnapshot();
  const access = effectiveAccessForKey(keyId);
  if (!access) return [];
  return entriesFor(snapshot, access, "resource_template");
}

/**
 * Whether this key's tool list is replaced by the discovery meta-tools.
 * `exposureMode = "discovery"` always is; `"direct"` turns into discovery past the threshold.
 */
export function isDiscoveryMode(exposureMode: string, visibleToolCount: number): boolean {
  let threshold: number;
  try {
    threshold = getSettings().discoveryThreshold;
  } catch {
    threshold = 0;
  }
  if (typeof threshold !== "number" || !Number.isFinite(threshold)) threshold = 0;
  return shouldUseDiscovery(exposureMode, visibleToolCount, threshold);
}

export function upstreamsByIds(ids: string[]): Map<string, { slug: string; name: string; description: string | null }> {
  const out = new Map<string, { slug: string; name: string; description: string | null }>();
  if (ids.length === 0) return out;
  const db = getDb();
  for (const id of ids) {
    const row = db.select().from(upstreams).where(eq(upstreams.id, id)).get();
    if (row) out.set(id, { slug: row.slug, name: row.name, description: row.description });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Per-key rate limiting (spec §10: 50 concurrent calls and 300 calls/min per key)
// ---------------------------------------------------------------------------------------------

interface KeyBudget {
  concurrent: number;
  /** Timestamps (ms) of the calls started in the current sliding minute. */
  recent: number[];
}

const budgets = new Map<string, KeyBudget>();

function budgetFor(keyId: string): KeyBudget {
  const existing = budgets.get(keyId);
  if (existing) return existing;
  const created: KeyBudget = { concurrent: 0, recent: [] };
  budgets.set(keyId, created);
  return created;
}

/** Explicit French error when a key exceeds its allowance (spec §10). */
export class RateLimitError extends McpError {
  constructor(message: string) {
    super(ErrorCode.InvalidParams, message);
    this.name = "RateLimitError";
  }
}

/** Throws when the key is over budget; returns the release function otherwise. */
function acquireBudget(keyId: string): () => void {
  const now = Date.now();
  const budget = budgetFor(keyId);
  budget.recent = budget.recent.filter((at) => at > now - 60_000);

  const maxConcurrent = config.defaults.maxConcurrentCallsPerKey;
  const maxPerMinute = config.defaults.maxCallsPerMinutePerKey;

  if (budget.concurrent >= maxConcurrent) {
    throw new RateLimitError(
      `Trop d'appels simultanés pour cette clé (maximum ${maxConcurrent}). Réessaie quand les appels en cours se terminent.`,
    );
  }
  if (budget.recent.length >= maxPerMinute) {
    throw new RateLimitError(
      `Trop d'appels pour cette clé (maximum ${maxPerMinute} par minute). Réessaie dans un instant.`,
    );
  }

  budget.concurrent += 1;
  budget.recent.push(now);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    budget.concurrent = Math.max(0, budget.concurrent - 1);
  };
}

/** Test helper: forgets every key's budget. */
export function resetRateLimits(): void {
  budgets.clear();
}

// ---------------------------------------------------------------------------------------------
// Denial logging / upstream messages
// ---------------------------------------------------------------------------------------------

function logDenied(
  ctx: GatewayCallContext,
  kind: string,
  name: string,
  upstreamId: string | null,
  reason: string,
): void {
  try {
    const id = logCall({
      keyId: ctx.keyId,
      sessionId: ctx.sessionId,
      upstreamId,
      kind,
      name,
      args: null,
      result: null,
      ok: false,
      errorCode: "not_found",
      denied: true,
      durationMs: 0,
    });
    emitUiEvent("call.logged", { id, denied: true, kind, name, keyId: ctx.keyId, reason });
  } catch {
    /* logging must never change the response */
  }
}

/** Actionable French message when the target upstream cannot serve the call (spec §6.2). */
export function upstreamUnavailableMessage(slug: string, status: string | null, lastError?: string | null): string {
  if (status === "auth_required") {
    return `Le serveur « ${slug} » demande une reconnexion OAuth dans Switchboard (page Serveurs).`;
  }
  if (status === "disabled") {
    return `Le serveur « ${slug} » est désactivé dans Switchboard : réactive-le dans la page Serveurs.`;
  }
  if (status === "error" || status === "degraded") {
    const detail = lastError ? ` Dernière erreur : ${lastError}` : "";
    return `Le serveur « ${slug} » est indisponible (statut : ${status}).${detail} Vérifie sa connexion dans Switchboard (page Serveurs).`;
  }
  return `Le serveur « ${slug} » n'est pas prêt (statut : ${status ?? "inconnu"}). Réessaie dans un instant ou vérifie sa connexion dans Switchboard.`;
}

function upstreamState(upstreamId: string): { status: string; lastError: string | null } | null {
  if (!hasUpstreamManager()) return null;
  try {
    const state = getUpstreamManager().getState(upstreamId);
    return state ? { status: state.status, lastError: state.lastError } : null;
  } catch {
    return null;
  }
}

function callTimeoutMs(upstreamId: string): number | undefined {
  try {
    const row = getDb()
      .select({ seconds: upstreams.callTimeoutSeconds })
      .from(upstreams)
      .where(eq(upstreams.id, upstreamId))
      .get();
    if (row && typeof row.seconds === "number" && row.seconds > 0) return row.seconds * 1000;
  } catch {
    /* defaults below */
  }
  return undefined;
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

// ---------------------------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------------------------

/**
 * Calls a public tool. Throws `McpError(InvalidParams, "Tool <name> not found")` when the name is
 * unknown OR not authorised by the key — the two cases are deliberately identical.
 */
export async function callPublicTool(
  publicName: string,
  args: Record<string, unknown> | undefined,
  ctx: GatewayCallContext,
): Promise<CallToolResult> {
  const started = Date.now();
  const routed = resolvePublicTool(publicName);
  const loaded = loadSessionAccess(ctx.keyId);
  if (!loaded) {
    logDenied(ctx, "tool", publicName, routed?.upstreamId ?? null, "unknown-key");
    throw notFoundError("tool", publicName);
  }

  const check = checkToolAccess(loaded.access, publicName, loaded.upstreamBySlug, loaded.disabledByUpstream);
  if (!check.allowed || !routed) {
    logDenied(ctx, "tool", publicName, routed?.upstreamId ?? null, check.reason ?? "unknown");
    throw notFoundError("tool", publicName);
  }

  const state = upstreamState(routed.upstreamId);
  if (state && state.status !== "ready") {
    const message = upstreamUnavailableMessage(routed.upstreamSlug, state.status, state.lastError);
    logCall({
      keyId: ctx.keyId,
      sessionId: ctx.sessionId,
      upstreamId: routed.upstreamId,
      kind: "tool",
      name: publicName,
      args,
      result: { error: message },
      ok: false,
      errorCode: "upstream-not-ready",
      durationMs: Date.now() - started,
    });
    return textResult(message, true);
  }

  if (!hasUpstreamManager()) {
    const message = "La passerelle n'a pas encore démarré ses connexions aux serveurs MCP. Réessaie dans un instant.";
    logCall({
      keyId: ctx.keyId,
      sessionId: ctx.sessionId,
      upstreamId: routed.upstreamId,
      kind: "tool",
      name: publicName,
      args,
      result: { error: message },
      ok: false,
      errorCode: "no-upstream-manager",
      durationMs: Date.now() - started,
    });
    return textResult(message, true);
  }

  // Per-key concurrency/rate limits (spec §10) apply to real upstream traffic only.
  let release: () => void;
  try {
    release = acquireBudget(ctx.keyId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logCall({
      keyId: ctx.keyId,
      sessionId: ctx.sessionId,
      upstreamId: routed.upstreamId,
      kind: "tool",
      name: publicName,
      args,
      result: { error: message },
      ok: false,
      errorCode: "rate-limited",
      durationMs: Date.now() - started,
    });
    throw error;
  }

  const manager = getUpstreamManager();
  const progressToken = ctx.progressToken;
  const sendNotification = ctx.sendNotification;
  const onProgress =
    progressToken !== undefined && sendNotification
      ? (progress: { progress: number; total?: number; message?: string }) => {
          void sendNotification({
            method: "notifications/progress",
            params: {
              progressToken,
              progress: progress.progress,
              ...(progress.total !== undefined ? { total: progress.total } : {}),
              ...(progress.message !== undefined ? { message: progress.message } : {}),
            },
          }).catch(() => undefined);
        }
      : undefined;

  try {
    await manager.ensureConnected(routed.upstreamId);
    const outcome = await manager.callTool(routed.upstreamId, routed.originalName, args ?? {}, {
      signal: ctx.signal,
      timeoutMs: callTimeoutMs(routed.upstreamId),
      onProgress,
    });
    const duration = Date.now() - started;
    const content = (Array.isArray(outcome.content) ? outcome.content : []) as CallToolResult["content"];
    const result: CallToolResult = {
      content: content.length > 0 ? content : [{ type: "text", text: "" }],
      ...(outcome.isError ? { isError: true } : {}),
      ...(outcome.structuredContent !== undefined
        ? { structuredContent: outcome.structuredContent as Record<string, unknown> }
        : {}),
    };
    logCall({
      keyId: ctx.keyId,
      sessionId: ctx.sessionId,
      upstreamId: routed.upstreamId,
      kind: "tool",
      name: publicName,
      args,
      result: outcome,
      ok: !outcome.isError,
      errorCode: outcome.isError ? "tool-error" : null,
      durationMs: duration,
    });
    return result;
  } catch (error) {
    const duration = Date.now() - started;
    if (ctx.signal?.aborted) {
      logCall({
        keyId: ctx.keyId,
        sessionId: ctx.sessionId,
        upstreamId: routed.upstreamId,
        kind: "tool",
        name: publicName,
        args,
        result: { error: "cancelled" },
        ok: false,
        errorCode: "cancelled",
        durationMs: duration,
      });
      return textResult("Appel annulé.", true);
    }
    const message = error instanceof Error ? error.message : String(error);
    logCall({
      keyId: ctx.keyId,
      sessionId: ctx.sessionId,
      upstreamId: routed.upstreamId,
      kind: "tool",
      name: publicName,
      args,
      result: { error: message },
      ok: false,
      errorCode: "upstream-error",
      durationMs: duration,
    });
    return textResult(
      `L'appel à « ${publicName} » a échoué sur le serveur « ${routed.upstreamSlug} » : ${message}`,
      true,
    );
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------------------------
// prompts/get
// ---------------------------------------------------------------------------------------------

export async function getPublicPrompt(
  publicName: string,
  args: Record<string, string> | undefined,
  ctx: GatewayCallContext,
): Promise<GetPromptResult> {
  const started = Date.now();
  const routed = resolvePublicPrompt(publicName);
  const loaded = loadSessionAccess(ctx.keyId);
  if (!loaded || !routed) {
    logDenied(ctx, "prompt", publicName, routed?.upstreamId ?? null, "unknown");
    throw notFoundError("prompt", publicName);
  }

  const entry = loaded.access.upstreams[routed.upstreamId];
  const allowed =
    entry?.prompts?.includes(routed.originalName) === true &&
    loaded.upstreamBySlug.get(routed.upstreamSlug)?.status === "ready";
  if (!allowed) {
    logDenied(ctx, "prompt", publicName, routed.upstreamId, entry ? "no-access" : "unknown");
    throw notFoundError("prompt", publicName);
  }
  if (!hasUpstreamManager()) {
    throw new McpError(ErrorCode.InternalError, "La passerelle n'a pas encore démarré ses connexions aux serveurs MCP.");
  }

  try {
    const result = await getUpstreamManager().getPrompt(routed.upstreamId, routed.originalName, args);
    logCall({
      keyId: ctx.keyId,
      sessionId: ctx.sessionId,
      upstreamId: routed.upstreamId,
      kind: "prompt",
      name: publicName,
      args,
      result,
      ok: true,
      durationMs: Date.now() - started,
    });
    return result as GetPromptResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logCall({
      keyId: ctx.keyId,
      sessionId: ctx.sessionId,
      upstreamId: routed.upstreamId,
      kind: "prompt",
      name: publicName,
      args,
      result: { error: message },
      ok: false,
      errorCode: "upstream-error",
      durationMs: Date.now() - started,
    });
    throw new McpError(
      ErrorCode.InternalError,
      upstreamUnavailableMessage(routed.upstreamSlug, upstreamState(routed.upstreamId)?.status ?? "error", message),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// resources/read + subscribe
// ---------------------------------------------------------------------------------------------

interface ResourceRoute {
  upstreamId: string;
  upstreamSlug: string;
  originalUri: string;
}

/** Resolves a resource URI (exact resource first, then a template prefix match). */
function resolveResourceRoute(uri: string): ResourceRoute | null {
  const exact = resolvePublicResource(uri);
  if (exact) return { upstreamId: exact.upstreamId, upstreamSlug: exact.upstreamSlug, originalUri: exact.originalUri };

  const parsed = parseResourceUri(uri);
  if (parsed.kind === "switchboard") {
    const rewritten = resolvePublicResource(uri);
    if (rewritten) {
      return {
        upstreamId: rewritten.upstreamId,
        upstreamSlug: rewritten.upstreamSlug,
        originalUri: rewritten.originalUri,
      };
    }
  }

  const snapshot = getCatalogSnapshot();
  for (const view of Object.values(snapshot.upstreams)) {
    for (const template of view.resourceTemplates) {
      const raw = template.definition?.uriTemplate ?? template.publicName;
      const prefix = raw.split("{")[0] ?? "";
      if (prefix.length > 0 && uri.startsWith(prefix)) {
        return { upstreamId: view.upstreamId, upstreamSlug: view.slug, originalUri: uri };
      }
    }
  }
  return null;
}

export async function readPublicResource(uri: string, ctx: GatewayCallContext): Promise<ReadResourceResult> {
  const started = Date.now();
  const route = resolveResourceRoute(uri);
  const loaded = loadSessionAccess(ctx.keyId);
  if (!loaded || !route) {
    logDenied(ctx, "resource", uri, route?.upstreamId ?? null, "unknown");
    throw notFoundError("resource", uri);
  }

  const entry = loaded.access.upstreams[route.upstreamId];
  const allowed =
    entry?.resources !== null &&
    entry?.resources !== undefined &&
    entry.resources.includes(route.originalUri) &&
    loaded.upstreamBySlug.get(route.upstreamSlug)?.status === "ready";
  if (!allowed) {
    logDenied(ctx, "resource", uri, route.upstreamId, "no-access");
    throw notFoundError("resource", uri);
  }
  if (!hasUpstreamManager()) {
    throw new McpError(ErrorCode.InternalError, "La passerelle n'a pas encore démarré ses connexions aux serveurs MCP.");
  }

  try {
    const result = await getUpstreamManager().readResource(route.upstreamId, route.originalUri);
    logCall({
      keyId: ctx.keyId,
      sessionId: ctx.sessionId,
      upstreamId: route.upstreamId,
      kind: "resource",
      name: uri,
      result,
      ok: true,
      durationMs: Date.now() - started,
    });
    return result as ReadResourceResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logCall({
      keyId: ctx.keyId,
      sessionId: ctx.sessionId,
      upstreamId: route.upstreamId,
      kind: "resource",
      name: uri,
      result: { error: message },
      ok: false,
      errorCode: "upstream-error",
      durationMs: Date.now() - started,
    });
    throw new McpError(
      ErrorCode.InternalError,
      upstreamUnavailableMessage(route.upstreamSlug, upstreamState(route.upstreamId)?.status ?? "error", message),
    );
  }
}

async function setSubscription(uri: string, subscribe: boolean, ctx: GatewayCallContext): Promise<void> {
  const route = resolveResourceRoute(uri);
  const loaded = loadSessionAccess(ctx.keyId);
  if (!loaded || !route) {
    logDenied(ctx, "resource", uri, route?.upstreamId ?? null, "unknown");
    throw notFoundError("resource", uri);
  }
  const entry = loaded.access.upstreams[route.upstreamId];
  const allowed =
    entry?.resources !== null &&
    entry?.resources !== undefined &&
    entry.resources.includes(route.originalUri) &&
    loaded.upstreamBySlug.get(route.upstreamSlug)?.status === "ready";
  if (!allowed) {
    logDenied(ctx, "resource", uri, route.upstreamId, "no-access");
    throw notFoundError("resource", uri);
  }
  if (!hasUpstreamManager()) {
    throw new McpError(ErrorCode.InternalError, "La passerelle n'a pas encore démarré ses connexions aux serveurs MCP.");
  }
  const manager = getUpstreamManager();
  try {
    if (subscribe) await manager.subscribeResource(route.upstreamId, route.originalUri);
    else await manager.unsubscribeResource(route.upstreamId, route.originalUri);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new McpError(
      ErrorCode.InternalError,
      upstreamUnavailableMessage(route.upstreamSlug, upstreamState(route.upstreamId)?.status ?? "error", message),
    );
  }
}

export function subscribePublicResource(uri: string, ctx: GatewayCallContext): Promise<void> {
  return setSubscription(uri, true, ctx);
}

export function unsubscribePublicResource(uri: string, ctx: GatewayCallContext): Promise<void> {
  return setSubscription(uri, false, ctx);
}
