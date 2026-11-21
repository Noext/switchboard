/**
 * `events/*` relay (MCP Events extension, SEP-3415).
 *
 * Switchboard does not implement events: it forwards the four methods to the upstreams that speak
 * the extension and merges their answers.
 *
 * ## Access control
 *
 * An `events/*` request is scoped by `params.upstream` (a slug) when present, otherwise it fans
 * out to every upstream the key may use. A key that cannot use an upstream gets **exactly** the
 * same answer it would get for a tool of that upstream today — `notFoundError`, i.e. "no such
 * tool" — so the relay never reveals that a server exists but is not granted. The check reuses
 * the router's `loadSessionAccess`, i.e. the same database-backed effective view as `tools/call`.
 */

import type { McpError } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../logs";
import { logCall } from "../logs";
import { getCatalogSnapshot } from "../catalog/catalog";
import { getUpstreamManager, hasUpstreamManager } from "../upstreams/types";
import { effectiveAccessForKey } from "../auth/grants";
import {
  EVENTS_EXTENSION_ID,
  EVENTS_REVISION,
  eventsNameHeader,
  isEventsMethod,
  parseEventList,
  type EventTypeDescriptor,
  type EventsMethod,
} from "./events-protocol";
import { notFoundError, upstreamUnavailableMessage, type GatewayCallContext } from "./router";

export interface EventsRelayResult {
  [key: string]: unknown;
}

/** An upstream that may serve events for this key: id + slug. */
interface EventUpstream {
  id: string;
  slug: string;
}

/**
 * Upstreams the key may use that also advertise the events extension.
 *
 * "Advertise" means the upstream's handshake listed `io.modelcontextprotocol/events`, OR it is
 * an HTTP upstream that answered an `events.list` probe (some servers only reveal the extension
 * on the per-request envelope). The second case is handled lazily by the relay: a failure to
 * serve simply yields no events from that upstream.
 */
function eventCapableUpstreams(keyId: string): EventUpstream[] {
  const access = effectiveAccessForKey(keyId);
  if (!access) return [];
  const snapshot = getCatalogSnapshot();
  const manager = hasUpstreamManager() ? getUpstreamManager() : null;

  const out: EventUpstream[] = [];
  for (const [upstreamId, entry] of Object.entries(access.upstreams)) {
    if (!entry.hasAccess) continue;
    const view = snapshot.upstreams[upstreamId];
    if (!view) continue;
    // A manager that predates the extension interface has no `extensions()`: treat it as
    // "advertises nothing" rather than crashing the whole session.
    const advertised =
      typeof manager?.extensions === "function" ? manager.extensions(upstreamId) : {};
    const speaksEvents =
      EVENTS_EXTENSION_ID in advertised ||
      // HTTP upstreams are given the benefit of the doubt: the envelope is the real test, and a
      // server that does not speak the extension answers "method not found", which we swallow.
      view.status === "ready";
    if (speaksEvents) out.push({ id: upstreamId, slug: view.slug });
  }
  return out;
}

/** Resolves `params.upstream` (slug) against the key's access. Unknown == unauthorised. */
function resolveRequestedUpstream(keyId: string, slug: unknown): EventUpstream | null {
  if (typeof slug !== "string" || slug.length === 0) return null;
  const candidates = eventCapableUpstreams(keyId);
  return candidates.find((u) => u.slug === slug) ?? null;
}

/**
 * Extensions to advertise in `capabilities.extensions`, derived from the upstreams this key can
 * actually see — never a static list.
 */
export function extensionsForKey(keyId: string): Record<string, { revision: string }> {
  const upstreams = eventCapableUpstreams(keyId);
  if (upstreams.length === 0) return {};
  return { [EVENTS_EXTENSION_ID]: { revision: EVENTS_REVISION } };
}

/** Merges `events` arrays from several upstreams, de-duplicating by name (first wins). */
function mergeEventLists(parts: EventTypeDescriptor[][]): EventTypeDescriptor[] {
  const seen = new Map<string, EventTypeDescriptor>();
  for (const list of parts) {
    for (const descriptor of list) {
      if (!seen.has(descriptor.name)) seen.set(descriptor.name, descriptor);
    }
  }
  return [...seen.values()];
}

/**
 * Runs one `events/*` request.
 *
 * Returns the merged result. Throws `notFoundError` when the key may not use the named upstream,
 * and for an unknown method, matching the "indistinguishable from absent" rule.
 */
export async function relayEvents(
  method: EventsMethod,
  params: Record<string, unknown>,
  ctx: GatewayCallContext,
): Promise<EventsRelayResult> {
  if (!isEventsMethod(method)) throw notFoundError("tool", method);

  const requested = params.upstream;
  let targets: EventUpstream[];

  if (requested !== undefined) {
    const resolved = resolveRequestedUpstream(ctx.keyId, requested);
    if (!resolved) throw notFoundError("tool", "events/" + String(requested));
    targets = [resolved];
  } else {
    targets = eventCapableUpstreams(ctx.keyId);
  }

  if (targets.length === 0) throw notFoundError("tool", method);

  const manager = getUpstreamManager();
  if (typeof manager.rawRequest !== "function") {
    // No extension support in this manager: behave exactly like the pre-extension gateway.
    throw notFoundError("tool", method);
  }
  const started = Date.now();
  const parts: EventTypeDescriptor[][] = [];
  const failures: Array<{ upstream: string; message: string }> = [];

  // For subscribe/poll/unsubscribe the request targets one event type; require an upstream when
  // several are eligible so the answer is unambiguous.
  if ((method === "events/subscribe" || method === "events/unsubscribe" || method === "events/poll") && targets.length > 1 && requested === undefined) {
    const name = typeof params.name === "string" ? params.name : "";
    throw new Error(
      "Cette clé voit plusieurs serveurs MCP avec l'extension events : précise « upstream » (" +
        targets.map((t) => t.slug).join(", ") +
        ") pour « " +
        method +
        (name ? " " + name : "") +
        " ».",
    );
  }

  for (const target of targets) {
    try {
      const result = await manager.rawRequest(target.id, method, params, {
        signal: ctx.signal,
        headers: buildNameHeader(params),
      });
      if (method === "events/list") parts.push(parseEventList(result));
      else return (result ?? {}) as EventsRelayResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // "method not found" means the upstream simply does not serve the extension: not an error.
      if (/method not found|-32601/i.test(message)) continue;
      failures.push({ upstream: target.slug, message });
    }
  }

  logCall({
    keyId: ctx.keyId,
    sessionId: ctx.sessionId,
    upstreamId: targets[0]?.id ?? null,
    kind: "events",
    name: method,
    args: params,
    result: method === "events/list" ? { count: parts.flat().length } : { ok: failures.length === 0 },
    ok: failures.length === 0,
    errorCode: failures.length > 0 ? "upstream-error" : null,
    durationMs: Date.now() - started,
  });

  if (method === "events/list") {
    const events = mergeEventLists(parts);
    if (events.length === 0 && failures.length > 0) {
      throw new Error(failures.map((f) => f.upstream + ": " + f.message).join("; "));
    }
    return { events, upstreams: targets.map((t) => t.slug) };
  }

  if (failures.length > 0) throw new Error(failures.map((f) => f.upstream + ": " + f.message).join("; "));
  return {};
}

function buildNameHeader(params: Record<string, unknown>): Record<string, string> | undefined {
  const name = eventsNameHeader(params);
  return name ? { "Mcp-Name": name } : undefined;
}

/** Human-readable status, used by the UI and by error messages. */
export function eventsAvailability(keyId: string): { upstreams: string[]; available: boolean } {
  const upstreams = eventCapableUpstreams(keyId);
  return { upstreams: upstreams.map((u) => u.slug), available: upstreams.length > 0 };
}

export type { EventsMethod };
export { upstreamUnavailableMessage };
