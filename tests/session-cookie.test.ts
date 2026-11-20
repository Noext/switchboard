import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Regression test for the LAN login loop.
 *
 * The session cookie used to be flagged `Secure` whenever NODE_ENV=production, even when the
 * request arrived over plain http (the supported LAN access path, spec §1.2). Browsers silently
 * drop a Secure cookie set from an http response, so a correct password bounced straight back to
 * /login. The flag must follow the real request scheme.
 */

let dir: string;
let dbmod: typeof import("../lib/db");

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-session-cookie-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_ADMIN_PASSWORD = "correct horse battery";
  process.env.SWITCHBOARD_SECRET = "a-long-enough-test-secret-32-chars";
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 21).toString("base64");
  vi.resetModules();
  dbmod = await import("../lib/db");
});

afterEach(() => {
  dbmod?.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function loginRequest(url: string, headers: Record<string, string> = {}, password = "correct horse battery"): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ password }),
  });
}

async function cookieHeaderFor(req: Request): Promise<string> {
  const { POST } = await import("../app/api/v1/session/route");
  const res = await POST(req);
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie") ?? "";
}

describe("session cookie over http vs https", () => {
  it("does NOT set Secure for a plain http request (the LAN access path)", async () => {
    const cookie = await cookieHeaderFor(loginRequest("http://switchboard.local:3020/api/v1/session"));
    expect(cookie).toContain("sb_admin=");
    expect(cookie).not.toMatch(/;\s*Secure/i);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("sets Secure for a direct https request", async () => {
    const cookie = await cookieHeaderFor(loginRequest("https://switchboard.example.com/api/v1/session"));
    expect(cookie).toMatch(/;\s*Secure/i);
  });

  it("trusts x-forwarded-proto from the reverse proxy", async () => {
    const viaProxy = await cookieHeaderFor(
      loginRequest("http://switchboard:3000/api/v1/session", { "x-forwarded-proto": "https" }),
    );
    expect(viaProxy).toMatch(/;\s*Secure/i);

    const directHttp = await cookieHeaderFor(
      loginRequest("http://switchboard.local:3020/api/v1/session", { "x-forwarded-proto": "http" }),
    );
    expect(directHttp).not.toMatch(/;\s*Secure/i);
  });

  it("handles a comma-separated x-forwarded-proto list", async () => {
    const cookie = await cookieHeaderFor(
      loginRequest("http://switchboard:3000/api/v1/session", { "x-forwarded-proto": "https, http" }),
    );
    expect(cookie).toMatch(/;\s*Secure/i);
  });

  it("still rejects a wrong password", async () => {
    const { POST } = await import("../app/api/v1/session/route");
    const res = await POST(loginRequest("http://switchboard.local:3020/api/v1/session", {}, "wrong"));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("DELETE clears the cookie with matching attributes", async () => {
    const { DELETE } = await import("../app/api/v1/session/route");
    const res = await DELETE(new Request("http://switchboard.local:3020/api/v1/session", { method: "DELETE" }));
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });

  it("a cookie issued over http authenticates a subsequent request", async () => {
    const cookie = await cookieHeaderFor(loginRequest("http://switchboard.local:3020/api/v1/session"));
    const token = /sb_admin=([^;]+)/.exec(cookie)?.[1] ?? "";
    const { GET } = await import("../app/api/v1/session/route");
    const res = await GET(
      new Request("http://switchboard.local:3020/api/v1/session", {
        headers: { cookie: `sb_admin=${token}` },
      }),
    );
    const body = (await res.json()) as { authenticated: boolean };
    expect(body.authenticated).toBe(true);
  });
});
