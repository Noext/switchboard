import { getDb } from "./db";
import { clearGlobalSingleton, peekGlobalSingleton, setGlobalSingleton } from "./runtime/global";
import { settings } from "./db/schema";

export interface AppSettings {
  publicUrl: string;
  feedbackEnabled: boolean;
  appriseUrl: string;
  appriseEnabled: boolean;
  logRetentionDays: number;
  logRetentionRows: number;
  discoveryThreshold: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  publicUrl: "",
  feedbackEnabled: true,
  appriseUrl: "",
  appriseEnabled: false,
  logRetentionDays: 30,
  logRetentionRows: 100_000,
  discoveryThreshold: 60,
};

interface SettingsCache {
  value: AppSettings;
  at: number;
}

const TTL = 2000;
const CACHE_KEY = "settings-cache";

/** Process-wide so a PATCH from a route handler invalidates the same cache the MCP server reads. */
function readCache(): SettingsCache | null {
  return peekGlobalSingleton<SettingsCache>(CACHE_KEY) ?? null;
}

function writeCache(cache: SettingsCache | null): void {
  if (cache === null) clearGlobalSingleton(CACHE_KEY);
  else setGlobalSingleton(CACHE_KEY, cache);
}

export function getSettings(): AppSettings {
  const cache = readCache();
  if (cache && Date.now() - cache.at < TTL) return cache.value;
  const db = getDb();
  const rows = db.select().from(settings).all();
  const value: AppSettings = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    const key = row.key as keyof AppSettings;
    if (key in value) {
      (value as any)[key] = row.value;
    }
  }
  writeCache({ value, at: Date.now() });
  return value;
}

export function setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
  const db = getDb();
  db.insert(settings)
    .values({ key, value: value as any })
    .onConflictDoUpdate({ target: settings.key, set: { value: value as any } })
    .run();
  writeCache(null);
}

export function updateSettings(patch: Partial<AppSettings>): AppSettings {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    setSetting(k as keyof AppSettings, v as any);
  }
  writeCache(null);
  return getSettings();
}

export function invalidateSettingsCache(): void {
  writeCache(null);
}
