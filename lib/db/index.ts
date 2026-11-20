import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { config, ensureDataDir } from "../config";
import { clearGlobalSingleton, globalSingleton } from "../runtime/global";
import * as schema from "./schema";
import { runMigrations } from "./migrate";

export type Db = BetterSQLite3Database<typeof schema>;

interface Handle {
  sqlite: Database.Database;
  db: Db;
}

const KEY = "db";

/**
 * One SQLite connection per process, shared by the custom server and Next's route handlers
 * (they are separate module graphs — see lib/runtime/global.ts).
 */
export function getDbHandle(): Handle {
  return globalSingleton<Handle>(KEY, () => {
    ensureDataDir();
    const sqlite = new Database(config.dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    runMigrations(sqlite);
    return { sqlite, db: drizzle(sqlite, { schema }) };
  });
}

export function getDb(): Db {
  return getDbHandle().db;
}

/** Test helper: closes the shared connection so a new data dir can be used. */
export function closeDb(): void {
  const existing = globalSingleton<Handle | null>(KEY, () => null);
  if (existing) {
    try {
      existing.sqlite.close();
    } catch {
      /* already closed */
    }
  }
  clearGlobalSingleton(KEY);
}

export function resetDbForTests(): void {
  clearGlobalSingleton(KEY);
}

export { schema };
