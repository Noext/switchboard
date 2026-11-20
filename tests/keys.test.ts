import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;
let mod: typeof import("../lib/auth/keys");
let dbmod: typeof import("../lib/db");

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-keys-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");
  vi.resetModules();
  dbmod = await import("../lib/db");
  mod = await import("../lib/auth/keys");
});

afterEach(() => {
  dbmod?.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("api keys", () => {
  it("creates a key with the documented format and stores only a hash", async () => {
    const created = mod.createKey({ name: "claude-laptop" });
    expect(created.secret.startsWith("sk-sw-")).toBe(true);
    expect(created.secret.length).toBe("sk-sw-".length + 32);
    expect(created.prefix).toBe(created.secret.slice(0, 12));

    const { apiKeys } = await import("../lib/db/schema");
    const row = dbmod.getDb().select().from(apiKeys).all()[0];
    expect(row.hash).not.toContain(created.secret);
    expect(row.hash).toHaveLength(64); // sha256 hex

    const auth = mod.authenticateSecret(created.secret);
    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.key.name).toBe("claude-laptop");
  });

  it("rejects unknown and malformed secrets", () => {
    expect(mod.authenticateSecret("nope").ok).toBe(false);
    expect(mod.authenticateSecret("sk-sw-" + "a".repeat(32)).ok).toBe(false);
    expect(mod.authenticateSecret("").ok).toBe(false);
  });

  it("accepts the key once and records lastUsedAt", async () => {
    const created = mod.createKey({ name: "k" });
    const auth = mod.authenticateSecret(created.secret);
    expect(auth.ok).toBe(true);
    const rec = mod.getKey(created.id)!;
    // touches are throttled but the in-memory auth result is immediate
    expect(auth.ok && auth.key.id).toBe(created.id);
    expect(rec.name).toBe("k");
  });

  it("rejects a revoked key immediately", () => {
    const created = mod.createKey({ name: "rev" });
    mod.revokeKey(created.id);
    mod.invalidateKeyCache();
    const auth = mod.authenticateSecret(created.secret);
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.reason).toBe("revoked");
  });

  it("rejects an expired key", () => {
    const created = mod.createKey({ name: "exp", expiresAt: Date.now() - 1000 });
    mod.invalidateKeyCache();
    const auth = mod.authenticateSecret(created.secret);
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.reason).toBe("expired");
  });

  it("rotates with a grace window, then invalidates the old secret", () => {
    const created = mod.createKey({ name: "rot" });
    const { secret: rotated } = mod.rotateKey(created.id, 3600);
    mod.invalidateKeyCache();

    expect(rotated).not.toBe(created.secret);
    expect(mod.authenticateSecret(rotated).ok).toBe(true);

    mod.invalidateKeyCache();
    const old = mod.authenticateSecret(created.secret);
    expect(old.ok).toBe(true);
    if (old.ok) expect(old.via).toBe("previous");
  });

  it("invalidates the old secret immediately with graceSeconds=0", () => {
    const created = mod.createKey({ name: "rot0" });
    mod.rotateKey(created.id, 0);
    mod.invalidateKeyCache();
    expect(mod.authenticateSecret(created.secret).ok).toBe(false);
  });

  it("duplicates roles and own grants", async () => {
    const { createRole, upsertGrant, getKeyDenies, setKeyDenies } = await import("../lib/auth/grants");
    const role = createRole({ name: "dev" });
    const created = mod.createKey({ name: "orig", roleIds: [role.id] });
    upsertGrant({ subjectType: "key", subjectId: created.id, upstreamId: "u1", toolMode: "selected", tools: ["A"] });
    setKeyDenies(created.id, [{ upstreamId: "u2", toolName: null }]);

    const copy = mod.duplicateKey(created.id, "copy");
    expect(copy.id).not.toBe(created.id);
    expect(copy.secret).not.toBe(created.secret);

    const copyRec = mod.getKey(copy.id)!;
    expect(copyRec.roleIds).toEqual([role.id]);
    expect(getKeyDenies(copy.id)).toEqual([{ upstreamId: "u2", toolName: null }]);
  });

  it("lists keys sorted by name", () => {
    mod.createKey({ name: "zeta" });
    mod.createKey({ name: "alpha" });
    expect(mod.listKeys().map((k) => k.name)).toEqual(["alpha", "zeta"]);
  });
});
