import { z } from "zod";
import { KEY_PREFIX, authenticateSecret } from "../auth/keys";
import { isAuthenticatedFromCookieHeader, isUiAuthenticated } from "../auth/session";

/**
 * Shared guard + response helpers for the admin REST API (`/api/v1/**`).
 *
 * Auth (spec §9): a request counts as admin when EITHER
 *   - it carries a UI session cookie (`sb_admin`) — actor "ui", OR
 *   - it carries `Authorization: Bearer sk-sw-…` for a key with `scope === "admin"` — actor "key:<name>".
 * Agent-scope keys are rejected with 403: they may only speak to `/mcp`, never the admin API.
 */

export type GuardOk = { ok: true; actor: string; keyId?: string };
export type GuardFail = { ok: false; status: number; error: string };
export type GuardResult = GuardOk | GuardFail;

/** Resolves the caller identity, or a failure the route must return as-is. Never throws. */
export async function requireAdmin(req: Request): Promise<GuardResult> {
  // 1. Bearer admin key.
  const authorization = req.headers.get("authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    const secret = match?.[1]?.trim();
    if (secret && secret.startsWith(KEY_PREFIX)) {
      let result;
      try {
        result = authenticateSecret(secret);
      } catch {
        return { ok: false, status: 401, error: "Invalid API key" };
      }
      if (!result.ok) return { ok: false, status: 401, error: "Invalid API key" };
      if (result.key.scope !== "admin") {
        return { ok: false, status: 403, error: "Admin-scope API key required" };
      }
      return { ok: true, actor: `key:${result.key.name}`, keyId: result.key.id };
    }
  }

  // 2. UI session cookie (works both in a Next request scope and in plain unit tests).
  if (isAuthenticatedFromCookieHeader(req.headers.get("cookie") ?? undefined)) {
    return { ok: true, actor: "ui" };
  }
  try {
    if (await isUiAuthenticated()) return { ok: true, actor: "ui" };
  } catch {
    /* `cookies()` outside a request scope (unit tests): fall through to 401. */
  }

  return { ok: false, status: 401, error: "Authentication required" };
}

/** JSON response with the right content type. */
export function json(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

/** Plain error envelope: `{ error, details? }`. */
export function errorResponse(status: number, error: string, details?: unknown): Response {
  return json(details === undefined ? { error } : { error, details }, { status });
}

export function badRequest(message: string, details?: unknown): Response {
  return errorResponse(400, message, details);
}

export function unauthorized(message = "Authentication required"): Response {
  return errorResponse(401, message);
}

export function forbidden(message = "Forbidden"): Response {
  return errorResponse(403, message);
}

export function notFound(message = "Not found"): Response {
  return errorResponse(404, message);
}

export function conflict(message: string): Response {
  return errorResponse(409, message);
}

export function unavailable(message: string): Response {
  return errorResponse(503, message);
}

export function serverError(message = "Internal server error", details?: unknown): Response {
  return errorResponse(500, message, details);
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

/** Turns a GuardFail into the matching HTTP response. */
export function guardResponse(guard: GuardFail): Response {
  return errorResponse(guard.status, guard.error);
}

export type ParseOk<T> = { ok: true; data: T };
export type ParseFail = { ok: false; response: Response };

/**
 * Parses and validates a JSON request body.
 *
 * Usage:
 * ```ts
 * const parsed = await parseBody(req, schema);
 * if (!parsed.ok) return parsed.response;
 * parsed.data // fully typed
 * ```
 */
export async function parseBody<T>(req: Request, schema: z.ZodType<T>): Promise<ParseOk<T> | ParseFail> {
  let raw: unknown;
  try {
    const text = await req.text();
    if (!text.trim()) return { ok: false, response: badRequest("Request body is required") };
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: badRequest("Invalid JSON body") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    return { ok: false, response: badRequest("Invalid request body", issues) };
  }
  return { ok: true, data: parsed.data };
}

/** Parses an optional JSON body (a missing body is validated as `{}`, so schema defaults apply). */
export async function parseOptionalBody<T>(req: Request, schema: z.ZodType<T>): Promise<ParseOk<T> | ParseFail> {
  const text = await req.text();
  if (!text.trim()) {
    const parsed = schema.safeParse({});
    if (!parsed.success) return { ok: false, response: badRequest("Invalid request body") };
    return { ok: true, data: parsed.data };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: badRequest("Invalid JSON body") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: badRequest(
        "Invalid request body",
        parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      ),
    };
  }
  return { ok: true, data: parsed.data };
}
