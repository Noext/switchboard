import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;
const envBackup = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-crypto-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  delete process.env.SWITCHBOARD_MASTER_KEY;
  // Reset module-level cache between tests.
  vi.resetModules();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...envBackup };
});

import { vi } from "vitest";

describe("crypto", () => {
  it("generates a master key file on first use", async () => {
    const mod = await import("../lib/crypto");
    const key = mod.getMasterKey();
    expect(key).toHaveLength(32);
    expect(existsSync(path.join(dir, "master.key"))).toBe(true);
    expect(mod.masterKeyExists()).toBe(true);
  });

  it("round-trips JSON and strings", async () => {
    const mod = await import("../lib/crypto");
    const payload = { token: "abc123", nested: { list: [1, 2, 3] } };
    const enc = mod.encryptJson(payload);
    expect(enc).toBeInstanceOf(Buffer);
    expect(enc.subarray(0, 1)[0]).toBe(1);
    expect(mod.decryptJson(enc)).toEqual(payload);

    const s = mod.encryptString("hello • world");
    expect(mod.decryptString(s)).toBe("hello • world");
  });

  it("produces different ciphertexts for equal plaintexts (random IV)", async () => {
    const mod = await import("../lib/crypto");
    const a = mod.encryptString("same");
    const b = mod.encryptString("same");
    expect(a.equals(b)).toBe(false);
    expect(mod.decryptString(a)).toBe(mod.decryptString(b));
  });

  it("fails on tampered ciphertext", async () => {
    const mod = await import("../lib/crypto");
    const enc = mod.encryptString("secret");
    enc[enc.length - 1] ^= 0xff;
    expect(() => mod.decryptString(enc)).toThrow();
  });

  it("hashes and compares in constant time", async () => {
    const mod = await import("../lib/crypto");
    expect(mod.sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(mod.constantTimeEqual("abc", "abc")).toBe(true);
    expect(mod.constantTimeEqual("abc", "abd")).toBe(false);
    expect(mod.constantTimeEqual("abc", "abcd")).toBe(false);
  });

  it("generates base62 secrets of the requested length", async () => {
    const mod = await import("../lib/crypto");
    const s = mod.randomBase62(32);
    expect(s).toHaveLength(32);
    expect(/^[0-9A-Za-z]+$/.test(s)).toBe(true);
    expect(mod.randomBase62(32)).not.toBe(s);
  });
});
