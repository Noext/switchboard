import { decryptJson, encryptJson } from "../crypto";

/**
 * Secret columns (`upstreams.env_enc`, `headers_enc`, `oauth_enc`) hold the base64 of the
 * AES-256-GCM ciphertext produced by `encryptJson`. They are NEVER returned by the API;
 * only booleans/key-names are exposed.
 */

/** Encrypts a JS value for storage in a text column (base64 of the ciphertext buffer). */
export function encodeSecret(value: unknown): string {
  return encryptJson(value).toString("base64");
}

/** Decrypts a value previously produced by {@link encodeSecret}. Returns null when absent/corrupt. */
export function decodeSecret<T>(text: string | null | undefined): T | null {
  if (!text) return null;
  try {
    return decryptJson<T>(Buffer.from(text, "base64"));
  } catch {
    return null;
  }
}

/** Decrypts a string map (env / headers), tolerating absent or corrupt values. */
export function decodeSecretMap(text: string | null | undefined): Record<string, string> | null {
  const value = decodeSecret<Record<string, string>>(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

/** Sorted key names only — never the values. */
export function secretKeys(text: string | null | undefined): string[] {
  const map = decodeSecretMap(text);
  return map ? Object.keys(map).sort() : [];
}

export interface OAuthBundle {
  clientId?: string;
  clientSecret?: string;
  tokens?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}
