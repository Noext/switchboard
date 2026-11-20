import { config } from "../config";

const ALLOWED = /^[a-zA-Z0-9_-]+$/;
const HASH_LEN = 4;

export interface PublicNameResult {
  publicName: string;
  truncated: boolean;
}

/**
 * Builds the public tool name `<slug>__<name>`.
 * Constraints: chars [a-zA-Z0-9_-], total <= 64 hard, aim <= 46 (clients add their own prefix).
 * Over the soft limit, the name is truncated and suffixed with 4 hash chars.
 */
export function buildPublicName(
  slug: string,
  name: string,
  maxLength: number = config.defaults.publicToolNameMaxLength,
): PublicNameResult {
  const safeSlug = sanitizeSegment(slug);
  const safeName = sanitizeSegment(name);
  const joined = `${safeSlug}__${safeName}`;
  if (joined.length <= maxLength) return { publicName: joined, truncated: false };

  const suffix = `_${shortHash(joined)}`;
  const keep = Math.max(1, maxLength - suffix.length);
  return { publicName: joined.slice(0, keep) + suffix, truncated: true };
}

/** Splits a public name into [slug, originalName] using the `__` separator. */
export function splitPublicName(publicName: string): [string, string] | null {
  const idx = publicName.indexOf("__");
  if (idx <= 0) return null;
  return [publicName.slice(0, idx), publicName.slice(idx + 2)];
}

export function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function isValidPublicName(value: string): boolean {
  return ALLOWED.test(value) && value.length <= config.defaults.publicToolNameHardMax;
}

/** Small deterministic hash (FNV-1a) rendered in base36, used for disambiguation. */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).slice(0, HASH_LEN).padStart(HASH_LEN, "0");
}

/** A slug must be short and stable: [a-z0-9]{1,12}. */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]{1,12}$/.test(slug);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 12);
}

/**
 * Resource URIs are forwarded as-is, except on collision where they are rewritten to
 * `switchboard://<slug>/<encoded uri>`.
 */
export function buildResourceUri(slug: string, uri: string, collision: boolean): string {
  if (!collision) return uri;
  return `switchboard://${slug}/${encodeURIComponent(uri)}`;
}

export function parseResourceUri(value: string): { kind: "raw" | "switchboard"; slug?: string; uri: string } {
  if (value.startsWith("switchboard://")) {
    const rest = value.slice("switchboard://".length);
    const slash = rest.indexOf("/");
    if (slash > 0) {
      return { kind: "switchboard", slug: rest.slice(0, slash), uri: decodeURIComponent(rest.slice(slash + 1)) };
    }
  }
  return { kind: "raw", uri: value };
}
