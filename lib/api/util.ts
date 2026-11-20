/** Small shared helpers for the admin REST API. */

/** Decodes a path parameter that may still be percent-encoded (tool names can contain chars Next escapes). */
export function decodeParam(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function intParam(url: URL, name: string, fallback?: number): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback ?? null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function boolParam(url: URL, name: string): boolean | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  if (raw === "" || raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return null;
}

export function clampLimit(value: number | null, fallback = 100, max = 500): number {
  if (value === null || value <= 0) return fallback;
  return Math.min(value, max);
}

export const ITEM_KINDS = ["tool", "prompt", "resource", "resource_template"] as const;
export type ApiItemKind = (typeof ITEM_KINDS)[number];

export function isItemKind(value: string): value is ApiItemKind {
  return (ITEM_KINDS as readonly string[]).includes(value);
}

/** Parses a `since` query param: ISO date or epoch ms. Returns ms or null. */
export function sinceParam(url: URL, name = "since"): number | null {
  const raw = url.searchParams.get(name);
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n)) return n;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function nowMs(): number {
  return Date.now();
}
