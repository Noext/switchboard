import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS, checkAdminPassword, createSessionToken } from "@/lib/auth/session";
import { json, parseBody, requireAdmin } from "@/lib/api/guard";
import { loginSchema } from "@/lib/api/schemas";
import { config } from "@/lib/config";

/**
 * GET /api/v1/session
 *   -> { authenticated: boolean, actor: "ui" | "key:<name>" | null }
 *
 * POST /api/v1/session   body: { password }
 *   -> 200 { authenticated: true } + Set-Cookie sb_admin=<signed token>; HttpOnly; SameSite=Lax
 *   -> 401 { error: "Invalid password" }
 *
 * DELETE /api/v1/session
 *   -> { authenticated: false } + clears the cookie
 */
/**
 * Builds the session cookie.
 *
 * The `Secure` flag is set only when the request actually arrived over HTTPS. Browsers silently
 * DROP a Secure cookie that is set from a plain-http response, which turns a correct password into
 * an endless redirect back to /login — a plain-http LAN address (http://switchboard.local:3020)
 * is a supported access path, so the flag must follow the real scheme, not NODE_ENV.
 *
 * Behind Traefik the external scheme comes from `x-forwarded-proto`; direct requests fall back to
 * the request URL's own protocol.
 */
function isHttpsRequest(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-proto");
  if (forwarded) return forwarded.split(",")[0]!.trim().toLowerCase() === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

function sessionCookie(value: string, maxAge: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  return json({ authenticated: guard.ok, actor: guard.ok ? guard.actor : null });
}

export async function POST(req: Request) {
  const parsed = await parseBody(req, loginSchema);
  if (!parsed.ok) return parsed.response;
  if (!checkAdminPassword(parsed.data.password)) {
    return json({ authenticated: false, error: "Invalid password" }, { status: 401 });
  }
  const token = createSessionToken();
  return json(
    { authenticated: true, actor: "ui" },
    {
      status: 200,
      headers: { "set-cookie": sessionCookie(token, SESSION_MAX_AGE_SECONDS, isHttpsRequest(req)) },
    },
  );
}

export async function DELETE(req: Request) {
  return json(
    { authenticated: false },
    { headers: { "set-cookie": sessionCookie("", 0, isHttpsRequest(req)) } },
  );
}
