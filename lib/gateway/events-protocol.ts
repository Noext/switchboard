/**
 * MCP Events extension (SEP-3415), revision 2026-07-28.
 *
 * Switchboard acts as a **relay**: it does not implement events itself, it forwards the
 * `events/*` methods to whichever upstreams speak the extension and merges their answers. This
 * module owns the wire details so no other file has to know them.
 *
 * ## Why a raw HTTP client instead of a SDK `Client`
 *
 * The extension revision 2026-07-28 is a *per-request envelope* protocol: there is no
 * `initialize` handshake, and every request must carry
 *   - the `MCP-Protocol-Version: 2026-07-28` header,
 *   - `Mcp-Method` (and `Mcp-Name` when the params carry a name),
 *   - `params._meta` with the protocol version and the client's capabilities,
 * including the extensions the client knows.
 *
 * The SDK's `Client` (both 1.32.2 and the published 2.4.0) insists on the legacy `initialize`
 * handshake: its default negotiation mode is `"legacy"` and it reports 2025-11-25, which makes
 * Harbor answer `{tools}` only — the extension is never advertised. Pinning
 * `versionNegotiation` did not change the negotiated version in testing. The vendored build in
 * Harbor's repo does speak the modern revision, but vendoring a pre-release fork of three
 * packages into this project was judged worse than 80 lines of explicit HTTP: the wire format is
 * small, documented and stable, and a raw path is free to pass headers the SDK does not model.
 *
 * So: legacy traffic (tools/prompts/resources) keeps using the SDK `Client`; `events/*` uses the
 * raw path below. Nothing about the legacy path changes.
 */

/** Extension id used in `capabilities.extensions` and in the per-request envelope. */
export const EVENTS_EXTENSION_ID = "io.modelcontextprotocol/events";

/** The revision this module implements. */
export const EVENTS_REVISION = "2026-07-28";

/** The four methods the extension defines. `events/stream` needs a GET; Harbor does not serve it. */
export const EVENTS_METHODS = [
  "events/list",
  "events/subscribe",
  "events/unsubscribe",
  "events/poll",
] as const;

export type EventsMethod = (typeof EVENTS_METHODS)[number];

export function isEventsMethod(method: string): method is EventsMethod {
  return (EVENTS_METHODS as readonly string[]).includes(method);
}

/** One event type as advertised by `events/list`. */
export interface EventTypeDescriptor {
  name: string;
  description?: string;
  delivery?: string[];
  inputSchema?: unknown;
  payloadSchema?: unknown;
}

export interface EventsEnvelope {
  "io.modelcontextprotocol/protocolVersion": string;
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: Record<string, { revision: string }>;
  };
}

/**
 * Builds the `params._meta` every modern request must carry.
 *
 * Harbor validates this literally: omitting a key yields `-32602` naming the missing one.
 */
export function eventsEnvelope(extensions: string[] = [EVENTS_EXTENSION_ID]): EventsEnvelope {
  const advertised: Record<string, { revision: string }> = {};
  for (const id of extensions) advertised[id] = { revision: EVENTS_REVISION };
  return {
    "io.modelcontextprotocol/protocolVersion": EVENTS_REVISION,
    "io.modelcontextprotocol/clientCapabilities": { extensions: advertised },
  };
}

/** Merges the envelope into params without clobbering an existing `_meta`. */
export function withEnvelope(
  params: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const base = { ...(params ?? {}), ...extra };
  const existingMeta = (base._meta ?? {}) as Record<string, unknown>;
  base._meta = { ...eventsEnvelope(), ...existingMeta };
  return base;
}

/**
 * The `Mcp-Name` header value for a request, when the params carry a name.
 *
 * The transport spec uses it for routing hints; Harbor reads it. `events/subscribe` and
 * `events/unsubscribe` name an event type, `events/poll` does not.
 */
export function eventsNameHeader(params: Record<string, unknown> | undefined): string | undefined {
  const name = params?.name;
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/** Shape check for an `events/list` result. */
export function parseEventList(result: unknown): EventTypeDescriptor[] {
  const events = (result as { events?: unknown })?.events;
  if (!Array.isArray(events)) return [];
  return events.filter(
    (e): e is EventTypeDescriptor => typeof e === "object" && e !== null && typeof (e as EventTypeDescriptor).name === "string",
  );
}
