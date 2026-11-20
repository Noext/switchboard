import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Creates a throwaway data dir for tests that touch the DB.
 * Usage:
 *   const h = await setupTestEnv();
 *   ... h.dir ...
 *   await h.teardown();
 */
export async function setupTestEnv(overrides: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-test-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_ADMIN_PASSWORD = "test-password";
  process.env.SWITCHBOARD_SECRET = "test-secret-that-is-long-enough-32";
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  Object.assign(process.env, overrides);

  // Fresh module state for every test file.
  const db = await import("../../lib/db");
  db.closeDb();

  return {
    dir,
    async teardown() {
      db.closeDb();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Inserts an upstream row directly (bypassing the manager) for catalog/access tests. */
export function insertUpstream(partial: Partial<{
  id: string;
  slug: string;
  name: string;
  transport: "http" | "sse" | "stdio";
  url: string | null;
  command: string | null;
  args: string[] | null;
  status: string;
  enabled: boolean;
  startMode: "always" | "lazy";
  authType: "none" | "headers" | "bearer" | "oauth";
}> = {}) {
  // Requires getDb() to be callable synchronously; callers import it themselves.
  return {
    id: partial.id ?? "u-" + Math.random().toString(36).slice(2, 8),
    slug: partial.slug ?? "toto",
    name: partial.name ?? "Toto",
    transport: partial.transport ?? "http",
    url: partial.url ?? "http://localhost:9/mcp",
    command: partial.command ?? null,
    args: partial.args ?? null,
    status: partial.status ?? "ready",
    enabled: partial.enabled ?? true,
    startMode: partial.startMode ?? "always",
    authType: partial.authType ?? "none",
  };
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
