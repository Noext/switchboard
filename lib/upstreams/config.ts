import { eq } from "drizzle-orm";
import type { ClientCapabilities, Implementation } from "@modelcontextprotocol/sdk/types.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { decryptJson } from "../crypto";
import { getDb } from "../db";
import { upstreams } from "../db/schema";
import { logger } from "../logs";
import { getRedactor } from "../redact";
import type { AuthType, UpstreamStatus, UpstreamTransport } from "../types";

/**
 * Storage convention for the encrypted columns (`env_enc`, `headers_enc`, `oauth_enc`):
 * a single-line base64 string wrapping the AES-256-GCM envelope produced by
 * `encryptJson()` — i.e. `encryptJson(value).toString("base64")`.
 */
export function decodeSecretJson<T = unknown>(value: string | null | undefined): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0) return null;

  // Primary format: base64 of [version|iv|tag|ciphertext].
  try {
    const decoded = decryptJson<T>(Buffer.from(text, "base64"));
    if (decoded !== null && decoded !== undefined) return decoded;
  } catch {
    /* fall through to the legacy/plain form */
  }

  // Defensive fallback: a plain JSON object (e.g. hand-written rows during development).
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text) as T;
    } catch {
      /* ignore */
    }
  }
  logger.warn("upstream secret column could not be decrypted; ignoring it");
  return null;
}

/** Persisted OAuth state for an upstream (everything the SDK provider must keep). */
export interface StoredOAuthState {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  discovery?: OAuthDiscoveryState;
  redirectUri?: string;
}

/** A fully resolved upstream config row, with secrets decrypted and memo of DB status. */
export interface ResolvedUpstream {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  transport: UpstreamTransport;
  url: string | null;
  command: string | null;
  args: string[] | null;
  cwd: string | null;
  env: Record<string, string> | null;
  headers: Record<string, string> | null;
  authType: AuthType;
  oauth: StoredOAuthState | null;
  enabled: boolean;
  startMode: "always" | "lazy";
  idleStopMinutes: number;
  callTimeoutSeconds: number;
  /** Status as persisted in the DB at load time (used to seed the runtime state). */
  dbStatus: UpstreamStatus;
  dbLastError: string | null;
  /** Stable hash of everything that requires a reconnect when it changes. */
  fingerprint: string;
}

export type UpstreamRow = typeof upstreams.$inferSelect;

/** Client identity announced to every upstream. */
export const CLIENT_INFO: Implementation = { name: "switchboard", version: "1.0.0" };

/**
 * Capabilities advertised to upstreams. Sampling / elicitation / roots are out of scope
 * for v1 (spec §6.2), so we deliberately announce an empty capability set.
 */
export const CLIENT_CAPABILITIES: ClientCapabilities = {};

function asStringMap(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (raw === null || raw === undefined) continue;
    out[key] = typeof raw === "string" ? raw : String(raw);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Registers every secret of a config with the global redactor (spec §10). */
export function registerSecrets(env: Record<string, string> | null, headers: Record<string, string> | null, oauth: StoredOAuthState | null): void {
  const redactor = getRedactor();
  redactor.registerRecord(env);
  redactor.registerRecord(headers);
  if (oauth?.tokens) {
    redactor.register(oauth.tokens.access_token);
    redactor.register(oauth.tokens.refresh_token);
    redactor.register(oauth.tokens.id_token);
  }
  if (oauth?.clientInformation?.client_secret) redactor.register(oauth.clientInformation.client_secret);
  // Authorization headers are the common bearer case; registered explicitly for clarity.
  const authorization = headers?.["Authorization"] ?? headers?.["authorization"];
  if (authorization) redactor.register(authorization.replace(/^Bearer\s+/i, ""));
}

export function fingerprintRow(row: UpstreamRow): string {
  return JSON.stringify([
    row.transport,
    row.url,
    row.command,
    row.args ?? null,
    row.cwd,
    row.envEnc ?? null,
    row.headersEnc ?? null,
    row.authType,
    row.enabled,
    row.startMode,
    row.idleStopMinutes,
    row.callTimeoutSeconds,
  ]);
}

/** Turns a DB row into a resolved config, decrypting secrets and registering them. */
export function resolveUpstream(row: UpstreamRow, options: { register?: boolean } = {}): ResolvedUpstream {
  const env = asStringMap(decodeSecretJson<unknown>(row.envEnc));
  const headers = asStringMap(decodeSecretJson<unknown>(row.headersEnc));
  const oauth = decodeSecretJson<StoredOAuthState>(row.oauthEnc);
  if (options.register !== false) registerSecrets(env, headers, oauth);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    transport: row.transport,
    url: row.url,
    command: row.command,
    args: Array.isArray(row.args) ? row.args : null,
    cwd: row.cwd,
    env,
    headers,
    authType: row.authType,
    oauth,
    enabled: row.enabled,
    startMode: row.startMode,
    idleStopMinutes: row.idleStopMinutes,
    callTimeoutSeconds: row.callTimeoutSeconds,
    dbStatus: row.status,
    dbLastError: row.lastError,
    fingerprint: fingerprintRow(row),
  };
}

/** Loads every configured upstream (secrets decrypted, redactor primed). */
export function loadUpstreamConfigs(): ResolvedUpstream[] {
  const rows = getDb().select().from(upstreams).all();
  return rows.map((row) => resolveUpstream(row));
}

/** Loads one upstream config, or null when the row no longer exists. */
export function loadUpstreamConfig(id: string): ResolvedUpstream | null {
  const row = getDb().select().from(upstreams).where(eq(upstreams.id, id)).get();
  return row ? resolveUpstream(row) : null;
}

/** Headers to send, including the Authorization header for bearer auth. */
export function effectiveHeaders(config: Pick<ResolvedUpstream, "headers" | "authType">): Record<string, string> {
  return config.headers ? { ...config.headers } : {};
}

/** True when the transport speaks HTTP (http or sse). */
export function isHttpTransport(transport: UpstreamTransport): boolean {
  return transport === "http" || transport === "sse";
}
