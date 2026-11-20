/**
 * Registration seam for runtime facts that live outside the API layer.
 *
 * The API must not import the gateway (wrong direction: the gateway imports the catalog and
 * the auth layer, and `server.ts` mounts both). Instead the gateway — or `server.ts` — calls
 * `registerSessionProvider()` at boot, and `GET /api/v1/status` reads the live session count
 * through it. Without a registration the endpoint reports an empty list, so tests and the
 * Next-only dev server keep working.
 *
 * Wiring (one line in server.ts, after `setUpstreamManager`):
 *
 *   import { registerSessionProvider } from "./lib/api/status-hooks";
 *   registerSessionProvider(() => gateway.listSessions());
 *
 * Each session should look like:
 *   { id, keyId, keyName, clientName, clientVersion, ip, since, lastSeenAt }
 */

export interface SessionSummary {
  id: string;
  keyId: string;
  keyName?: string | null;
  clientName?: string | null;
  clientVersion?: string | null;
  ip?: string | null;
  since?: number | null;
  lastSeenAt?: number | null;
  [key: string]: unknown;
}

export type SessionProvider = () => SessionSummary[];

let provider: SessionProvider | null = null;

/** Called once by the gateway/server at boot. Registering twice replaces the provider. */
export function registerSessionProvider(next: SessionProvider | null): void {
  provider = next;
}

export function hasSessionProvider(): boolean {
  return provider !== null;
}

/** Never throws: a broken provider degrades to "no sessions" instead of failing the dashboard. */
export function listOpenSessions(): SessionSummary[] {
  if (!provider) return [];
  try {
    const sessions = provider();
    return Array.isArray(sessions) ? sessions : [];
  } catch {
    return [];
  }
}

export function sessionsForKey(keyId: string): SessionSummary[] {
  return listOpenSessions().filter((session) => session.keyId === keyId);
}
