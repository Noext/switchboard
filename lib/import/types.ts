/**
 * Shared types for the config import/export feature (spec §8 "Import", §6.4).
 *
 * Parsers produce `ParsedServer` values that still hold the secret material; anything sent over
 * the wire to the UI goes through `toPreview()`, which only exposes key *names* and secret flags.
 */

export type ImportFormat = "claude-code" | "claude-desktop" | "codex";

export type ImportTransport = "http" | "sse" | "stdio";
export type ImportAuthType = "none" | "headers" | "bearer" | "oauth";

/** Where a secret was found in the pasted config. */
export interface SecretLocation {
  location: "env" | "header" | "bearer_token_env_var";
  key: string;
}

/** A server extracted from a client config. Secrets are still in clear here (server-side only). */
export interface ParsedServer {
  name: string;
  transport: ImportTransport;
  url: string | null;
  command: string | null;
  args: string[] | null;
  cwd: string | null;
  env: Record<string, string>;
  headers: Record<string, string>;
  /** Codex `bearer_token_env_var`: name of the env var holding the token. */
  bearerTokenEnvVar: string | null;
  authType: ImportAuthType;
  enabled: boolean;
  /** Projects this server was declared in (`~/.claude.json`); empty means global scope. */
  projects: string[];
  warnings: string[];
  /** Human label for the source, e.g. "global" or a project path. */
  scope: string;
}

export interface ParsedImport {
  format: ImportFormat;
  servers: ParsedServer[];
  warnings: string[];
}

/** Safe, UI-facing view of one detected server. Never contains secret values. */
export interface ImportPreviewServer {
  name: string;
  slug: string;
  transport: ImportTransport;
  url: string | null;
  command: string | null;
  args: string[] | null;
  cwd: string | null;
  authType: ImportAuthType;
  /** Environment variable names only. */
  envKeys: string[];
  /** HTTP header names only. */
  headerKeys: string[];
  bearerTokenEnvVar: string | null;
  secrets: SecretLocation[];
  hasSecrets: boolean;
  enabled: boolean;
  projects: string[];
  scope: string;
  warnings: string[];
  /** True when an upstream with this slug already exists (the slug would be suffixed). */
  slugTaken: boolean;
}

export interface ImportPreview {
  format: ImportFormat;
  servers: ImportPreviewServer[];
  warnings: string[];
  counts: { servers: number; stdio: number; http: number; secrets: number };
}

/** What the UI sends back for the servers it wants to import. */
export interface ImportSelection {
  name: string;
  /** Optional slug override; validated/normalised server-side. */
  slug?: string;
  transport?: ImportTransport;
  url?: string | null;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  bearerTokenEnvVar?: string | null;
  authType?: ImportAuthType;
  enabled?: boolean;
}

export interface ImportResult {
  created: string[];
  skipped: string[];
  createdSlugs: string[];
  skippedReasons: Record<string, string>;
  warnings: string[];
  /** Servers imported but requiring admin attention (e.g. bearer token not provided). */
  needsAttention: Array<{ slug: string; reason: string }>;
}
