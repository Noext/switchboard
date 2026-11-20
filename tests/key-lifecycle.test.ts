import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;
let dbmod: typeof import("../lib/db");

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-lifecycle-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 17).toString("base64");
  vi.resetModules();
  dbmod = await import("../lib/db");
});

afterEach(() => {
  dbmod?.closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("key lifecycle notifications", () => {
  it("emits revoked so the gateway can close live sessions (spec §6.1)", async () => {
    const keys = await import("../lib/auth/keys");
    const seen: string[] = [];
    const off = keys.onKeyLifecycle((e) => seen.push(`${e.type}:${e.keyId}`));
    const created = keys.createKey({ name: "k" });
    keys.revokeKey(created.id);
    expect(seen).toContain(`revoked:${created.id}`);
    off();
  });

  it("emits rotated with the key id", async () => {
    const keys = await import("../lib/auth/keys");
    const seen: string[] = [];
    const off = keys.onKeyLifecycle((e) => seen.push(e.type));
    const created = keys.createKey({ name: "k" });
    keys.rotateKey(created.id, 0);
    expect(seen).toContain("rotated");
    off();
  });

  it("flags access-affecting updates but not cosmetic ones", async () => {
    const keys = await import("../lib/auth/keys");
    const events: Array<{ type: string; affectsAccess: boolean }> = [];
    const off = keys.onKeyLifecycle((e) => {
      if (e.type === "updated") events.push({ type: e.type, affectsAccess: e.affectsAccess });
    });
    const created = keys.createKey({ name: "k" });

    keys.updateKey(created.id, { description: "cosmetic" });
    expect(events.at(-1)?.affectsAccess).toBe(false);

    keys.updateKey(created.id, { exposureMode: "discovery" });
    expect(events.at(-1)?.affectsAccess).toBe(true);

    keys.updateKey(created.id, { roleIds: [] });
    expect(events.at(-1)?.affectsAccess).toBe(true);
    off();
  });

  it("survives a throwing listener and still notifies the others", async () => {
    const keys = await import("../lib/auth/keys");
    const reached: string[] = [];
    const offBad = keys.onKeyLifecycle(() => {
      throw new Error("boom");
    });
    const offGood = keys.onKeyLifecycle((e) => reached.push(e.type));
    const created = keys.createKey({ name: "k" });
    expect(() => keys.revokeKey(created.id)).not.toThrow();
    expect(reached).toContain("revoked");
    offBad();
    offGood();
  });

  it("does not notify after unsubscribe", async () => {
    const keys = await import("../lib/auth/keys");
    let count = 0;
    const off = keys.onKeyLifecycle(() => count++);
    const created = keys.createKey({ name: "k" });
    keys.revokeKey(created.id);
    const afterFirst = count;
    off();
    keys.rotateKey(created.id, 0);
    expect(count).toBe(afterFirst);
  });
});
