"use client";

/** Small fetch wrapper for client components: same-origin cookies, JSON, typed errors. */

export interface ApiErrorInfo {
  status: number;
  message: string;
  body: unknown;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(info: ApiErrorInfo) {
    super(info.message);
    this.name = "ApiError";
    this.status = info.status;
    this.body = info.body;
  }
}

function extractMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const rec = body as Record<string, unknown>;
    const candidates = [rec.error, rec.message, rec.detail];
    for (const c of candidates) {
      if (typeof c === "string" && c.length > 0) return c;
      if (c && typeof c === "object" && typeof (c as Record<string, unknown>).message === "string") {
        return (c as Record<string, string>).message;
      }
    }
  }
  if (typeof body === "string" && body.length > 0 && body.length < 400) return body;
  return fallback;
}

export async function apiRequest<T = unknown>(
  path: string,
  init?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? "GET",
    headers:
      init?.body === undefined
        ? { Accept: "application/json" }
        : { "Content-Type": "application/json", Accept: "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
    signal: init?.signal,
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    throw new ApiError({
      status: res.status,
      body: parsed,
      message: extractMessage(parsed, "HTTP " + res.status),
    });
  }
  return parsed as T;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
