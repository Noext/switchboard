import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { config } from "../config";
import { constantTimeEqual } from "../crypto";

export const SESSION_COOKIE = "sb_admin";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionPayload {
  exp: number;
  nonce: string;
}

function sign(value: string): string {
  return createHmac("sha256", config.secret).update(value).digest("base64url");
}

export function createSessionToken(): string {
  const payload: SessionPayload = { exp: Date.now() + SESSION_TTL_MS, nonce: randomBytes(8).toString("hex") };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  if (!constantTimeEqual(sig, sign(body))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Compares the submitted password with SWITCHBOARD_ADMIN_PASSWORD in constant time. */
export function checkAdminPassword(submitted: string): boolean {
  return constantTimeEqual(submitted, config.adminPassword);
}

/** Server-side helper: is the current request authenticated through the UI cookie? */
export async function isUiAuthenticated(): Promise<boolean> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value) !== null;
}

/** Same, but synchronous for the custom Node server (reads the Cookie header). */
export function isAuthenticatedFromCookieHeader(cookieHeader: string | undefined): boolean {
  if (!cookieHeader) return false;
  const match = cookieHeader.split(/;\s*/).find((c) => c.startsWith(SESSION_COOKIE + "="));
  if (!match) return false;
  return verifySessionToken(decodeURIComponent(match.slice(SESSION_COOKIE.length + 1))) !== null;
}

export const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
