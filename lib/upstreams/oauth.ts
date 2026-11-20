import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { config } from "../config";
import { encryptJson, randomToken } from "../crypto";
import { getDb } from "../db";
import { oauthStates, upstreams } from "../db/schema";
import { logger } from "../logs";
import { getRedactor } from "../redact";
import { decodeSecretJson, type StoredOAuthState } from "./config";

/**
 * OAuth 2.1 client for upstreams (spec §4.2, §10).
 *
 * - PKCE (S256) + signed `state` bound to the upstream, stored in `oauth_states`
 *   with a 10 minute TTL.
 * - Client registration (CIMD / dynamic registration / manual credentials) and token
 *   refresh are driven by the SDK's `auth()` helper.
 * - Everything persisted (client info, tokens, discovery state) lands encrypted in
 *   `upstreams.oauth_enc`.
 */

/** `state` TTL: spec §10 says 10 minutes. */
export const OAUTH_STATE_TTL_MS = config.defaults.oauthStateTtlMs;

/** Path of the gateway callback route (app/oauth/callback/route.ts). */
export const OAUTH_CALLBACK_PATH = "/oauth/callback";

export function oauthRedirectUri(): string {
  return `${config.publicUrl}${OAUTH_CALLBACK_PATH}`;
}

/** Signing/verification of the OAuth `state` parameter (HMAC-SHA256, base64url). */
export function signState(raw: string, secret: string): string {
  return createHmac("sha256", secret).update(raw, "utf8").digest("base64url");
}

export function createSignedState(secret: string): string {
  const raw = randomToken(24);
  return `${raw}.${signState(raw, secret)}`;
}

/** Returns the raw part when the signature is valid, null otherwise. */
export function verifySignedState(state: string, secret: string): string | null {
  const dot = state.lastIndexOf(".");
  if (dot <= 0 || dot === state.length - 1) return null;
  const raw = state.slice(0, dot);
  const signature = state.slice(dot + 1);
  const expected = signState(raw, secret);
  const a = Buffer.from(signature, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? raw : null;
}

/** Persistence for the encrypted OAuth blob of one upstream. */
export interface OAuthStore {
  load(): StoredOAuthState | null;
  save(state: StoredOAuthState): void;
  /** The MCP server URL (needed by the SDK auth flow). */
  serverUrl(): string;
  /** Upstream id, used for state binding and event payloads. */
  upstreamId(): string;
}

/** DB-backed store: single-line base64 of encryptJson(...) in upstreams.oauth_enc. */
export class DbOAuthStore implements OAuthStore {
  constructor(private readonly id: string) {}

  load(): StoredOAuthState | null {
    const row = getDb().select().from(upstreams).where(eq(upstreams.id, this.id)).get();
    if (!row) return null;
    return decodeSecretJson<StoredOAuthState>(row.oauthEnc);
  }

  save(state: StoredOAuthState): void {
    const payload = encryptJson(state satisfies StoredOAuthState).toString("base64");
    getDb()
      .update(upstreams)
      .set({ oauthEnc: payload })
      .where(eq(upstreams.id, this.id))
      .run();
    // Tokens change on refresh: keep the redactor up to date.
    const redactor = getRedactor();
    redactor.register(state.tokens?.access_token);
    redactor.register(state.tokens?.refresh_token);
    redactor.register(state.clientInformation?.client_secret);
  }

  serverUrl(): string {
    const row = getDb().select().from(upstreams).where(eq(upstreams.id, this.id)).get();
    return row?.url ?? "";
  }

  upstreamId(): string {
    return this.id;
  }
}

export interface OAuthManagerOptions {
  store: OAuthStore;
  clientName?: string;
  /** Overrides oauthRedirectUri() (tests). */
  redirectUri?: string;
  /** Called when a refresh fails: the manager flips the status to auth_required. */
  onAuthRequired?: (upstreamId: string, error: string) => void;
  now?: () => number;
}

export class OAuthManager implements OAuthClientProvider {
  private readonly store: OAuthStore;
  private readonly redirectUriValue: string;
  private readonly clientName: string;
  private options: OAuthManagerOptions;
  private now: () => number;

  /** State generated for the flow in progress (also the key of the oauth_states row). */
  private pendingState: string | null = null;
  /** URL captured from redirectToAuthorization(). */
  private pendingAuthorizationUrl: string | null = null;

  constructor(options: OAuthManagerOptions) {
    this.options = options;
    this.store = options.store;
    this.redirectUriValue = options.redirectUri ?? oauthRedirectUri();
    this.clientName = options.clientName ?? "Switchboard";
    this.now = options.now ?? (() => Date.now());
  }

  // ---- OAuthClientProvider -------------------------------------------------

  get redirectUrl(): string {
    return this.redirectUriValue;
  }

  get clientMetadata(): OAuthClientMetadata {
    const clientInformation = this.store.load()?.clientInformation;
    return {
      redirect_uris: [this.redirectUriValue],
      token_endpoint_auth_method: clientInformation?.client_secret ? "client_secret_post" : "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: this.clientName,
      software_id: "switchboard",
    };
  }

  /** Signed, upstream-bound state persisted in oauth_states (10 min TTL). */
  state(): string {
    const signed = createSignedState(config.secret);
    this.pendingState = signed;
    const now = this.now();
    const db = getDb();
    db.delete(oauthStates).where(lt(oauthStates.expiresAt, now)).run();
    db.insert(oauthStates)
      .values({
        state: signed,
        upstreamId: this.store.upstreamId(),
        codeVerifier: "",
        redirectUri: this.redirectUriValue,
        createdAt: now,
        expiresAt: now + OAUTH_STATE_TTL_MS,
      })
      .run();
    return signed;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.store.load()?.clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    const current = this.store.load() ?? {};
    this.store.save({ ...current, clientInformation });
  }

  tokens(): OAuthTokens | undefined {
    return this.store.load()?.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const current = this.store.load() ?? {};
    this.store.save({ ...current, tokens });
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.pendingAuthorizationUrl = authorizationUrl.toString();
  }

  saveCodeVerifier(codeVerifier: string): void {
    if (!this.pendingState) {
      // Not part of a browser flow: keep it in memory for the pending exchange.
      this.volatileVerifier = codeVerifier;
      return;
    }
    getDb()
      .update(oauthStates)
      .set({ codeVerifier })
      .where(eq(oauthStates.state, this.pendingState))
      .run();
  }

  codeVerifier(): string {
    if (!this.pendingState) {
      if (this.volatileVerifier) return this.volatileVerifier;
      throw new Error("no pending OAuth authorization flow");
    }
    const row = getDb().select().from(oauthStates).where(eq(oauthStates.state, this.pendingState)).get();
    if (!row || row.codeVerifier.length === 0) throw new Error("no stored PKCE code verifier for this state");
    if (row.expiresAt < this.now()) throw new Error("OAuth state expired; start the connection again");
    return row.codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    const current = this.store.load() ?? {};
    this.store.save({ ...current, discovery: state });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.store.load()?.discovery ?? undefined;
  }

  /** Clears stored credentials when the server says they are invalid. */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const current = this.store.load() ?? {};
    const next: StoredOAuthState = { ...current };
    if (scope === "all" || scope === "tokens") delete next.tokens;
    if (scope === "all" || scope === "client") delete next.clientInformation;
    if (scope === "all" || scope === "discovery") delete next.discovery;
    if (scope === "all") delete next.redirectUri;
    this.store.save(next);
  }

  private volatileVerifier: string | null = null;

  // ---- manager-side API ----------------------------------------------------

  get authorizationUrl(): string | null {
    return this.pendingAuthorizationUrl;
  }

  /**
   * Starts the browser authorization flow and returns the URL the admin must visit.
   * Stored tokens are dropped first so the server always shows a consent screen.
   */
  async startOAuth(): Promise<{ authorizationUrl: string }> {
    const serverUrl = this.store.serverUrl();
    if (!serverUrl) throw new Error("this upstream has no URL configured for OAuth");
    this.pendingAuthorizationUrl = null;

    const current = this.store.load() ?? {};
    if (current.tokens) {
      const next: StoredOAuthState = { ...current };
      delete next.tokens;
      this.store.save(next);
    }

    const result = await auth(this, { serverUrl });
    if (result === "AUTHORIZED") {
      throw new Error("the upstream authorized the client without a browser redirect");
    }
    if (!this.pendingAuthorizationUrl) {
      throw new Error("the authorization server did not return an authorization URL");
    }
    return { authorizationUrl: this.pendingAuthorizationUrl };
  }

  /**
   * Completes the flow from the callback query params: verifies `state` (signature,
   * upstream binding, TTL), exchanges the code, and persists the tokens.
   */
  async completeOAuth(params: Record<string, string>): Promise<void> {
    const error = params.error;
    if (error) {
      const description = params.error_description ? ` (${params.error_description})` : "";
      throw new Error(`authorization refused: ${error}${description}`);
    }
    const state = params.state;
    const code = params.code;
    if (!state) throw new Error("missing OAuth state parameter");
    if (!code) throw new Error("missing OAuth code parameter");

    const raw = verifySignedState(state, config.secret);
    if (!raw) throw new Error("invalid OAuth state signature");
    const db = getDb();
    const row = db.select().from(oauthStates).where(eq(oauthStates.state, state)).get();
    if (!row) throw new Error("unknown or already used OAuth state");
    if (row.upstreamId !== this.store.upstreamId()) throw new Error("OAuth state does not belong to this upstream");
    if (row.expiresAt < this.now()) {
      db.delete(oauthStates).where(eq(oauthStates.state, state)).run();
      throw new Error("OAuth state expired; start the connection again");
    }

    const serverUrl = this.store.serverUrl();
    if (!serverUrl) throw new Error("this upstream has no URL configured for OAuth");

    this.pendingState = state;
    try {
      const result = await auth(this, { serverUrl, authorizationCode: code });
      if (result !== "AUTHORIZED") throw new Error("token exchange did not authorize the client");
    } catch (refreshError) {
      this.options.onAuthRequired?.(this.store.upstreamId(), errorMessage(refreshError));
      throw refreshError;
    } finally {
      db.delete(oauthStates).where(and(eq(oauthStates.state, state), eq(oauthStates.upstreamId, this.store.upstreamId()))).run();
      this.pendingState = null;
      this.volatileVerifier = null;
    }
  }

  /**
   * Ensures a usable access token: refreshes when a refresh token exists.
   * Returns false when the upstream needs the admin to reconnect (auth_required).
   */
  async ensureAuthorized(): Promise<boolean> {
    const serverUrl = this.store.serverUrl();
    if (!serverUrl) return false;
    try {
      const result = await auth(this, { serverUrl });
      return result === "AUTHORIZED";
    } catch (error) {
      logger.warn({ err: errorMessage(error), upstreamId: this.store.upstreamId() }, "OAuth refresh failed");
      this.options.onAuthRequired?.(this.store.upstreamId(), errorMessage(error));
      return false;
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
