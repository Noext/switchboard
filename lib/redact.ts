import { clearGlobalSingleton, globalSingleton } from "./runtime/global";

/**
 * Secret masking. Upstream secrets are stored encrypted; this keeps known plaintext values
 * out of logs, events, stderr and call previews. Values are registered by the upstream layer
 * when a config is loaded from the DB.
 */

class Redactor {
  private secrets = new Set<string>();

  register(value: string | null | undefined): void {
    if (!value) return;
    const trimmed = value.trim();
    if (trimmed.length < 4) return;
    this.secrets.add(trimmed);
  }

  registerMany(values: Iterable<string | null | undefined>): void {
    for (const v of values) this.register(v);
  }

  /** Registers every string value of a headers/env map plus bearer tokens. */
  registerRecord(record: Record<string, string> | null | undefined): void {
    if (!record) return;
    for (const v of Object.values(record)) this.register(v);
  }

  redact(text: string, _keyId?: string): string {
    let out = text;
    for (const secret of this.secrets) {
      if (secret && out.includes(secret)) out = out.split(secret).join("••••");
    }
    // Generic patterns as a safety net.
    out = out.replace(/\b(sk-sw-[A-Za-z0-9]{4})[A-Za-z0-9]{8,}/g, "$1••••");
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}=*/g, "$1••••");
    return out;
  }

  redactDeep<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as unknown as T;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (/token|secret|password|authorization|api[-_]?key/i.test(k) && typeof v === "string") {
          out[k] = "••••";
        } else {
          out[k] = this.redactDeep(v);
        }
      }
      return out as unknown as T;
    }
    return value;
  }

  clear(): void {
    this.secrets.clear();
  }

  size(): number {
    return this.secrets.size;
  }
}

const REDACTOR_KEY = "redactor";

/**
 * One redactor per process: upstream secrets are registered by the custom server when it decrypts
 * a config, and must also mask text written by Next route handlers (call logs, events, feedback).
 */
export function getRedactor(): Redactor {
  return globalSingleton<Redactor>(REDACTOR_KEY, () => new Redactor());
}

/** Test helper. */
export function clearRedactor(): void {
  clearGlobalSingleton(REDACTOR_KEY);
}
