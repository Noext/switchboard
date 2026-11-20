import "server-only";
import { redirect } from "next/navigation";
import { isUiAuthenticated } from "@/lib/auth/session";

/**
 * Server-side auth gate for every admin page (spec §8: "auth UI = mot de passe admin + cookie signé").
 * Redirects to /login when the session cookie is missing or expired.
 */
export async function requireUiAuth(): Promise<void> {
  const authed = await isUiAuthenticated();
  if (!authed) redirect("/login");
}

/** Same, but returns a boolean for places that render conditionally (layout shell). */
export async function uiAuthState(): Promise<boolean> {
  try {
    return await isUiAuthenticated();
  } catch {
    return false;
  }
}
