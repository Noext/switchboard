import { requireAdmin, json, notFound, guardResponse } from "@/lib/api/guard";
import { getDb } from "@/lib/db";
import { upstreams } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { getUpstreamManager, hasUpstreamManager } from "@/lib/upstreams/types";
import { EVENTS_METHODS, EVENTS_EXTENSION_ID, EVENTS_REVISION } from "@/lib/gateway/events-protocol";

/**
 * GET /api/v1/upstreams/{id}/events
 *
 * Lists the MCP Events types an upstream serves, for the admin UI.
 *
 * The gateway relays `events/*` and forwards the modern per-request envelope
 * (`lib/gateway/events-protocol.ts`); this endpoint reuses `Manager.rawRequest` so the UI sees
 * exactly what an agent would. Admin session or admin-scope key required.
 *
 * Responses:
 *   200 { supported: true,  revision: "2026-07-28", events: EventTypeDescriptor[], upstream: {slug, name} }
 *   200 { supported: false, reason: string,          events: [],  upstream: {slug, name} }
 *   404 { error: "Upstream not found" }
 *
 * "supported: false" is a normal answer (a server that simply does not implement the extension);
 * it is not an HTTP error, so the UI can render it as a state rather than a failure.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireAdmin(_req);
  if (!guard.ok) return guardResponse(guard as never);
  const { id } = await ctx.params;

  const row = getDb().select().from(upstreams).where(eq(upstreams.id, id)).get();
  if (!row) return notFound("Upstream not found");

  const meta = { slug: row.slug, name: row.name };

  if (!hasUpstreamManager()) {
    return json({ supported: false, reason: "La passerelle n'a pas démarré son gestionnaire d'upstreams.", events: [], upstream: meta });
  }
  const manager = getUpstreamManager();
  if (typeof manager.rawRequest !== "function") {
    return json({ supported: false, reason: "Cette version de la passerelle ne relaie pas les extensions.", events: [], upstream: meta });
  }
  if (row.transport === "stdio") {
    return json({ supported: false, reason: "Les upstreams stdio ne servent pas les extensions MCP.", events: [], upstream: meta });
  }
  if (!row.url) {
    return json({ supported: false, reason: "Cet upstream n'a pas d'URL configurée.", events: [], upstream: meta });
  }

  try {
    const result = (await manager.rawRequest(id, "events/list", {}, { timeoutMs: 15_000 })) as {
      events?: unknown;
    };
    const events = Array.isArray(result?.events) ? result.events : [];
    return json({
      supported: true,
      revision: EVENTS_REVISION,
      extension: EVENTS_EXTENSION_ID,
      methods: EVENTS_METHODS,
      events,
      upstream: meta,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // "method not found" / "not supported" is the ordinary answer for a server without the
    // extension. Anything else (unreachable, auth) is surfaced as a reason, still HTTP 200 so the
    // UI can show it inline.
    if (/method not found|-32601|not support|unsupported/i.test(message)) {
      return json({
        supported: false,
        reason: "Ce serveur ne sert pas l'extension MCP Events (events/list : méthode inconnue).",
        events: [],
        upstream: meta,
      });
    }
    return json({
      supported: false,
      reason: message.slice(0, 400),
      events: [],
      upstream: meta,
      error: true,
    });
  }
}
