import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-session-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_ADMIN_PASSWORD = "correct horse";
  process.env.SWITCHBOARD_SECRET = "a-long-enough-test-secret-32-chars";
  vi.resetModules();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("admin session", () => {
  it("checks the password in constant time, including non-matching lengths", async () => {
    const mod = await import("../lib/auth/session");
    expect(mod.checkAdminPassword("correct horse")).toBe(true);
    expect(mod.checkAdminPassword("wrong")).toBe(false);
    expect(mod.checkAdminPassword("correct horse ")).toBe(false);
    expect(mod.checkAdminPassword("")).toBe(false);
  });

  it("issues a signed token that verifies", async () => {
    const mod = await import("../lib/auth/session");
    const token = mod.createSessionToken();
    expect(token.split(".")).toHaveLength(2);
    const payload = mod.verifySessionToken(token);
    expect(payload?.exp).toBeGreaterThan(Date.now());
  });

  it("rejects tampered or foreign-signature tokens", async () => {
    const mod = await import("../lib/auth/session");
    const token = mod.createSessionToken();
    const [body, sig] = token.split(".");

    // Flip a character in the body.
    const tampered = body.slice(0, -1) + (body.endsWith("A") ? "B" : "A") + "." + sig;
    expect(mod.verifySessionToken(tampered)).toBeNull();

    // Forge a payload with a far-future expiry but no valid signature.
    const forgedBody = Buffer.from(JSON.stringify({ exp: Date.now() + 1e9, nonce: "x" })).toString("base64url");
    expect(mod.verifySessionToken(forgedBody + "." + sig)).toBeNull();

    expect(mod.verifySessionToken("garbage")).toBeNull();
    expect(mod.verifySessionToken(undefined)).toBeNull();
    expect(mod.verifySessionToken("")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const mod = await import("../lib/auth/session");
    const token = mod.createSessionToken();
    const [body, sig] = token.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    payload.exp = Date.now() - 1;
    const expiredBody = Buffer.from(JSON.stringify(payload)).toString("base64url");
    // Re-sign correctly with the same secret so only expiry is wrong.
    const { createHmac } = await import("node:crypto");
    const goodSig = createHmac("sha256", process.env.SWITCHBOARD_SECRET!)
      .update(expiredBody)
      .digest("base64url");
    expect(mod.verifySessionToken(expiredBody + "." + goodSig)).toBeNull();
  });

  it("parses the session out of a raw Cookie header", async () => {
    const mod = await import("../lib/auth/session");
    const token = mod.createSessionToken();
    expect(mod.isAuthenticatedFromCookieHeader(`other=1; ${mod.SESSION_COOKIE}=${token}; x=2`)).toBe(true);
    expect(mod.isAuthenticatedFromCookieHeader(`other=1`)).toBe(false);
    expect(mod.isAuthenticatedFromCookieHeader(undefined)).toBe(false);
    expect(mod.isAuthenticatedFromCookieHeader(`${mod.SESSION_COOKIE}=bogus.0`)).toBe(false);
  });
});

describe("settings", () => {
  it("returns defaults then persists updates", async () => {
    const mod = await import("../lib/settings");
    const { closeDb } = await import("../lib/db");
    const initial = mod.getSettings();
    expect(initial.feedbackEnabled).toBe(true);
    expect(initial.discoveryThreshold).toBe(60);
    expect(initial.appriseEnabled).toBe(false);

    mod.updateSettings({ feedbackEnabled: false, discoveryThreshold: 40, appriseEnabled: true });
    const after = mod.getSettings();
    expect(after.feedbackEnabled).toBe(false);
    expect(after.discoveryThreshold).toBe(40);
    expect(after.appriseEnabled).toBe(true);

    // Survives a cache invalidation (persisted to SQLite, not memory).
    mod.invalidateSettingsCache();
    expect(mod.getSettings().discoveryThreshold).toBe(40);
    closeDb();
  });
});
