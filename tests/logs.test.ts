import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let dir: string;
const envBackup = { ...process.env };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-logs-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  vi.resetModules();
});

afterEach(async () => {
  const { closeDb } = await import("../lib/db");
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...envBackup };
});

describe("redactor", () => {
  it("masks registered secrets and generic patterns", async () => {
    const { getRedactor } = await import("../lib/redact");
    const r = getRedactor();
    r.clear();
    r.register("super-secret-token");
    r.registerRecord({ Authorization: "Bearer abcdefghijklmnop" });
    expect(r.redact("value is super-secret-token here")).toBe("value is •••• here");
    expect(r.redact("Authorization: Bearer abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
    expect(r.redact("key sk-sw-abcd1234567890")).toContain("••••");
  });

  it("redacts deeply and by suspicious key name", async () => {
    const { getRedactor } = await import("../lib/redact");
    const r = getRedactor();
    r.clear();
    const out = r.redactDeep({ token: "abc", nested: { password: "x", keep: "visible" } });
    expect(out).toEqual({ token: "••••", nested: { password: "••••", keep: "visible" } });
  });
});

describe("logCall / pruneCallLogs", () => {
  it("stores truncated previews with secrets masked", async () => {
    const { getRedactor } = await import("../lib/redact");
    getRedactor().clear();
    getRedactor().register("topsecretvalue");
    const { logCall } = await import("../lib/logs");
    const id = logCall({
      keyId: "k1",
      kind: "tool",
      name: "gh__create",
      args: { body: "x".repeat(5000), token: "topsecretvalue" },
      ok: true,
      durationMs: 12,
    });
    expect(id).toBeTruthy();
    const { getDb } = await import("../lib/db");
    const { callLogs } = await import("../lib/db/schema");
    const row = getDb().select().from(callLogs).all()[0];
    expect(row.name).toBe("gh__create");
    expect(row.argsPreview!.length).toBeLessThan(2100);
    expect(row.argsPreview).not.toContain("topsecretvalue");
  });

  it("prunes rows older than the retention window", async () => {
    const { getDb } = await import("../lib/db");
    const { callLogs } = await import("../lib/db/schema");
    const old = Date.now() - 40 * 86_400_000;
    getDb()
      .insert(callLogs)
      .values({ id: "old", at: old, kind: "tool", name: "x", ok: true })
      .run();
    const { logCall, pruneCallLogs } = await import("../lib/logs");
    logCall({ kind: "tool", name: "recent", ok: true });
    pruneCallLogs();
    const rows = getDb().select().from(callLogs).all();
    expect(rows.map((r) => r.name)).toEqual(["recent"]);
  });
});
