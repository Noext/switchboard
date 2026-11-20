import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { oauthStates } from "@/lib/db/schema";
import { getUpstreamManager, hasUpstreamManager } from "@/lib/upstreams/types";
import { logEvent } from "@/lib/logs";
import { emitUiEvent } from "@/lib/events";

/**
 * GET /oauth/callback?code=…&state=…        (spec §4.2 step 3)
 *
 * The OAuth redirect target registered with the authorization server. It looks the `state` up in
 * `oauth_states` (signed/opaque, 10 min TTL, bound to one upstream), forwards every query
 * parameter to `UpstreamManager.completeOAuth(upstreamId, params)` and then redirects the browser
 * to `/servers/<id>?oauth=ok` (or `?oauth=error&reason=…`).
 *
 * This route is browser-facing, so it never returns JSON: always a 302.
 */
export const dynamic = "force-dynamic";

function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": "no-store" } });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const params: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) params[key] = value;

  const state = params.state;
  if (!state) {
    logEvent({ actor: "oauth", type: "upstream.oauth_callback_invalid", message: "OAuth callback without state" });
    return redirect("/servers?oauth=error&reason=missing_state");
  }

  const db = getDb();
  const row = db.select().from(oauthStates).where(eq(oauthStates.state, state)).get();
  if (!row) {
    logEvent({ actor: "oauth", type: "upstream.oauth_callback_invalid", message: "OAuth callback with unknown state" });
    return redirect("/servers?oauth=error&reason=unknown_state");
  }
  if (row.expiresAt <= Date.now()) {
    db.delete(oauthStates).where(eq(oauthStates.state, state)).run();
    logEvent({
      actor: "oauth",
      type: "upstream.oauth_callback_expired",
      message: "OAuth state expired",
      upstreamId: row.upstreamId,
      data: { upstreamId: row.upstreamId },
    });
    return redirect(`/servers/${row.upstreamId}?oauth=error&reason=expired`);
  }

  // The provider may report an error instead of a code (user denied, etc.).
  if (params.error) {
    db.delete(oauthStates).where(eq(oauthStates.state, state)).run();
    logEvent({
      actor: "oauth",
      type: "upstream.oauth_denied",
      message: `OAuth authorization failed: ${params.error}`,
      upstreamId: row.upstreamId,
      data: { error: params.error, description: params.error_description ?? null },
    });
    return redirect(`/servers/${row.upstreamId}?oauth=error&reason=${encodeURIComponent(params.error)}`);
  }

  if (!hasUpstreamManager()) {
    return redirect(`/servers/${row.upstreamId}?oauth=error&reason=manager_unavailable`);
  }

  try {
    await getUpstreamManager().completeOAuth(row.upstreamId, params);
  } catch (error) {
    const message = error instanceof Error ? error.message : "OAuth completion failed";
    logEvent({
      actor: "oauth",
      type: "upstream.oauth_failed",
      message,
      upstreamId: row.upstreamId,
      data: { upstreamId: row.upstreamId },
    });
    emitUiEvent("upstream.status", { upstreamId: row.upstreamId });
    return redirect(`/servers/${row.upstreamId}?oauth=error&reason=${encodeURIComponent(message.slice(0, 120))}`);
  }

  db.delete(oauthStates).where(eq(oauthStates.state, state)).run();
  logEvent({
    actor: "oauth",
    type: "upstream.oauth_completed",
    message: "OAuth flow completed",
    upstreamId: row.upstreamId,
    data: { upstreamId: row.upstreamId, redirectUri: row.redirectUri },
  });
  emitUiEvent("upstream.status", { upstreamId: row.upstreamId });
  return redirect(`/servers/${row.upstreamId}?oauth=ok`);
}
