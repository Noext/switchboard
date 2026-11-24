import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${name}`);
}

export const config = {
  get publicUrl(): string {
    return env("SWITCHBOARD_PUBLIC_URL", "http://localhost:3000").replace(/\/$/, "");
  },
  get adminPassword(): string {
    return env("SWITCHBOARD_ADMIN_PASSWORD", "changeme");
  },
  get secret(): string {
    return env("SWITCHBOARD_SECRET", "insecure-dev-secret-please-change-32chars");
  },
  get dataDir(): string {
    return path.resolve(/*turbopackIgnore: true*/ env("SWITCHBOARD_DATA_DIR", "./data"));
  },
  get port(): number {
    return Number(env("SWITCHBOARD_PORT", "3000"));
  },
  get logLevel(): string {
    return env("SWITCHBOARD_LOG_LEVEL", "info");
  },
  get isProd(): boolean {
    return process.env.NODE_ENV === "production";
  },
  get mcpPath(): string {
    return "/mcp";
  },
  get dbPath(): string {
    return path.join(this.dataDir, "switchboard.db");
  },
  get masterKeyPath(): string {
    return path.join(this.dataDir, "master.key");
  },
  // Tunables (overridable through the settings table at runtime)
  defaults: {
    publicToolNameMaxLength: 46,
    publicToolNameHardMax: 64,
    sessionIdleTimeoutHours: 24,
    callLogRetentionDays: 30,
    callLogRetentionRows: 100_000,
    discoveryThreshold: 60,
    reconnectBackoffMs: [1000, 2000, 4000, 8000, 16000, 32000, 60000] as number[],
    healthPingIntervalMs: 60_000,
    idleStopMinutes: 15,
    callTimeoutSeconds: 120,
    catalogDebounceMs: 500,
    keyCacheTtlMs: 5_000,
    feedbackRateLimitPerHour: 20,
    maxConcurrentCallsPerKey: 50,
    maxCallsPerMinutePerKey: 300,
    sseKeepAliveMs: 25_000,
    oauthStateTtlMs: 10 * 60 * 1000,
    /**
     * Upper bound on an MCP POST body, in bytes (spec §11.4).
     *
     * The SDK's own default is 4 MiB, and it is far too small for what agents send THROUGH
     * this gateway: a 15 MB git bundle is ~20 MB of base64, and Harbor deliberately accepts
     * 64 MiB bundles. The relay was therefore stricter than every upstream behind it, and
     * the symptom was silent: the client got "Payload Too Large: ... 4194304 bytes" from a
     * layer it never chose, then worked around the gateway by serving the payload over HTTP
     * from the host into the sandbox — solving Switchboard's problem with the caller's time.
     *
     * Sized above the largest upstream request Harbor accepts so the narrowest limit an
     * agent meets is the one the tool descriptions advertise.
     */
    maxRequestBodyBytes: 128 * 1024 * 1024,
  },
};

export function ensureDataDir(): void {
  const dir = config.dataDir;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
