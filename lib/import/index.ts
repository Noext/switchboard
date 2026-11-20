/**
 * Config import/export (spec §8 "Import", §6.4).
 *
 * Three input formats are supported — Claude Code (`.mcp.json` / `~/.claude.json`), Claude
 * Desktop (`claude_desktop_config.json`) and Codex (`~/.codex/config.toml`). Parsing is pure;
 * `previewImport()` strips every secret value before anything reaches the UI, and
 * `importServers()` is the only function that writes upstream rows.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { decryptJson, encryptJson } from "../crypto";
import { getDb } from "../db";
import { apiKeys, upstreams } from "../db/schema";
import { emitUiEvent } from "../events";
import { logEvent } from "../logs";
import { isValidSlug, slugify } from "../catalog/naming";
import { invalidateCatalog } from "../catalog/catalog";
import { effectiveAccessForKey } from "../auth/grants";
import {
  buildClaudeCodeCommand,
  buildCodexConfig,
  buildJsonSnippet,
  mcpEndpoint,
  publicBaseUrl,
} from "../api/install";
import { getUpstreamManager, hasUpstreamManager } from "../upstreams/types";
import { parseClaudeCodeJson } from "./claude-code";
import { parseClaudeDesktopJson } from "./claude-desktop";
import { parseCodexToml } from "./codex";
import type {
  ImportFormat,
  ImportPreview,
  ImportPreviewServer,
  ImportResult,
  ImportSelection,
  ParsedImport,
  ParsedServer,
  SecretLocation,
} from "./types";

export { parseClaudeCodeJson, ImportParseError } from "./claude-code";
export { parseClaudeDesktopJson, CLAUDE_DESKTOP_DEFAULT_PATHS } from "./claude-desktop";
export { parseCodexToml } from "./codex";
export { parseToml, TomlError } from "./toml";
export * from "./types";

// ---------------------------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------------------------

/**
 * Guesses the config format from the payload text. An explicit `format` always wins.
 * Codex is TOML (`[mcp_servers.x]`); `~/.claude.json` is recognised by its `projects` map;
 * a JSON `mcpServers` map with only stdio entries is treated as Claude Desktop.
 */
export function detectFormat(payload: string): ImportFormat {
  const text = payload.trim();

  // Codex is TOML. Check it first: a TOML table header also starts with "[", and a JSON
  // array is never a valid client config, so this order is unambiguous.
  if (/^\s*\[mcp_servers/m.test(text) || /^\s*\[\[/m.test(text)) return "codex";
  if (!text.startsWith("{") && !text.startsWith("[")) {
    // Bare "key = value" TOML with no [mcp_servers] header (still parseable as Codex).
    if (/^\s*[A-Za-z0-9_.-]+\s*=/m.test(text)) return "codex";
    return "claude-code";
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON at all: treat "a = b" as TOML, anything else as a broken JSON config.
    return /^\s*[A-Za-z0-9_.-]+\s*=/m.test(text) ? "codex" : "claude-code";
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const doc = parsed as Record<string, unknown>;
    if (doc.projects !== undefined) return "claude-code";
    const servers = doc.mcpServers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      const hasRemote = Object.values(servers as Record<string, unknown>).some(
        (s) => s && typeof s === "object" && ("url" in (s as object) || "type" in (s as object)),
      );
      return hasRemote ? "claude-code" : "claude-desktop";
    }
  }
  return "claude-code";
}

/** Parses a payload in the given (or detected) format. */
export function parseImport(payload: string, format?: ImportFormat): ParsedImport {
  const resolved = format ?? detectFormat(payload);
  switch (resolved) {
    case "claude-desktop":
      return parseClaudeDesktopJson(payload);
    case "codex":
      return parseCodexToml(payload);
    case "claude-code":
    default:
      return parseClaudeCodeJson(payload);
  }
}

// ---------------------------------------------------------------------------------------------
// Slug allocation
// ---------------------------------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9]{1,12}$/;
const SLUG_FALLBACK = "mcp";

/** Derives a valid, unused slug from a server name (suffix `2`..`99` on collision). */
export function allocateSlug(name: string, taken: Set<string>): string {
  let base = slugify(name);
  if (base.length === 0) base = SLUG_FALLBACK;
  base = base.slice(0, 12);
  if (!SLUG_PATTERN.test(base)) base = SLUG_FALLBACK;
  if (!taken.has(base)) return base;
  for (let i = 2; i <= 99; i++) {
    const suffix = String(i);
    const candidate = base.slice(0, 12 - suffix.length) + suffix;
    if (SLUG_PATTERN.test(candidate) && !taken.has(candidate)) return candidate;
  }
  return (base.slice(0, 8) + randomUUID().replace(/-/g, "").slice(0, 4)).slice(0, 12);
}

function existingSlugs(): Set<string> {
  try {
    return new Set(
      getDb()
        .select({ slug: upstreams.slug })
        .from(upstreams)
        .all()
        .map((r) => r.slug),
    );
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------------------------
// Secret detection / preview
// ---------------------------------------------------------------------------------------------

export function detectSecrets(server: ParsedServer): SecretLocation[] {
  const found: SecretLocation[] = [];
  for (const key of Object.keys(server.env)) found.push({ location: "env", key });
  for (const key of Object.keys(server.headers)) found.push({ location: "header", key });
  if (server.bearerTokenEnvVar) found.push({ location: "bearer_token_env_var", key: server.bearerTokenEnvVar });
  return found;
}

const ARG_SECRET_PATTERN = /sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[bap]-[A-Za-z0-9-]{10,}|[A-Za-z0-9_\-]{40,}/;

/** Safe view for the UI: names and flags only, never values. */
export function toPreviewServer(
  server: ParsedServer,
  slug: string,
  taken: Set<string>,
  /** The server's natural (un-suffixed) slug, used to report a collision to the UI. */
  naturalSlug: string = slug,
): ImportPreviewServer {
  const secrets = detectSecrets(server);
  const warnings = [...server.warnings];
  if (server.transport === "stdio" && Array.isArray(server.args)) {
    const suspicious = server.args.filter((arg) => ARG_SECRET_PATTERN.test(arg));
    if (suspicious.length > 0) {
      warnings.push(
        `${suspicious.length} argument(s) look like credentials; they are stored encrypted but env vars are safer.`,
      );
    }
  }
  if (taken.has(naturalSlug)) {
    warnings.push(
      `Slug "${naturalSlug}" is already used by another upstream; "${slug}" will be used instead.`,
    );
  }
  return {
    name: server.name,
    slug,
    transport: server.transport,
    url: server.url,
    // The admin pasted these themselves, and the preview is admin-only.
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    authType: server.authType,
    envKeys: Object.keys(server.env),
    headerKeys: Object.keys(server.headers),
    bearerTokenEnvVar: server.bearerTokenEnvVar,
    secrets,
    hasSecrets: secrets.length > 0,
    enabled: server.enabled,
    projects: server.projects,
    scope: server.scope,
    warnings,
    // True when the name's natural slug is already used, i.e. import will append a suffix.
    slugTaken: taken.has(naturalSlug),
  };
}

/** Parses a config and strips every secret value. The only entry point the UI should use. */
export function previewImport(payload: string, format?: ImportFormat): ImportPreview {
  const parsed = parseImport(payload, format);
  const taken = existingSlugs();
  const used = new Set<string>();
  const servers: ImportPreviewServer[] = [];
  let secretCount = 0;

  for (const server of parsed.servers) {
    const slug = allocateSlug(server.name, new Set([...taken, ...used]));
    used.add(slug);
    const naturalSlug = allocateSlug(server.name, new Set());
    const preview = toPreviewServer(server, slug, taken, naturalSlug);
    if (preview.hasSecrets) secretCount += preview.secrets.length;
    servers.push(preview);
  }

  return {
    format: parsed.format,
    servers,
    warnings: parsed.warnings,
    counts: {
      servers: servers.length,
      stdio: servers.filter((s) => s.transport === "stdio").length,
      http: servers.filter((s) => s.transport !== "stdio").length,
      secrets: secretCount,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Import (write path)
// ---------------------------------------------------------------------------------------------

/** Normalises one selection entry into a full ParsedServer (the UI may send a partial object). */
function normalizeSelection(selection: ImportSelection): ParsedServer | null {
  const transport = selection.transport ?? (selection.command ? "stdio" : "http");
  const url = selection.url ?? null;
  const command = selection.command ?? null;
  if (transport !== "stdio" && !url) return null;
  if (transport === "stdio" && !command) return null;

  const headers = selection.headers ?? {};
  let authType = selection.authType;
  if (!authType) {
    if (Object.keys(headers).length === 0) authType = "none";
    else {
      const bearer = Object.entries(headers).some(
        ([key, value]) => key.toLowerCase() === "authorization" && /^bearer\s+/i.test(value.trim()),
      );
      authType = bearer ? "bearer" : "headers";
    }
  }

  return {
    name: selection.name,
    transport,
    url: transport === "stdio" ? null : url,
    command: transport === "stdio" ? command : null,
    args: selection.args ?? null,
    cwd: selection.cwd ?? null,
    env: transport === "stdio" ? (selection.env ?? {}) : {},
    headers: transport === "stdio" ? {} : headers,
    bearerTokenEnvVar: selection.bearerTokenEnvVar ?? null,
    authType,
    enabled: selection.enabled ?? true,
    projects: [],
    warnings: [],
    scope: "import",
  };
}

/** Encodes a secret map the way the upstream layer stores it: base64 of the encrypted JSON buffer. */
export function encodeEncRecord(map: Record<string, string>): string | null {
  if (Object.keys(map).length === 0) return null;
  return encryptJson(map).toString("base64");
}

/** Decodes an encrypted json column stored as base64 (upstreams convention). */
export function decodeEncRecord(value: string | null | undefined): Record<string, string> | null {
  if (!value) return null;
  try {
    return decryptJson<Record<string, string>>(Buffer.from(value, "base64")) ?? null;
  } catch {
    return null;
  }
}

/**
 * Creates upstream rows for the selected servers (spec §8 "import sélectif").
 *
 * Secrets are encrypted with the master key; the auth type is inferred from the headers; each
 * created upstream starts as `connecting` and is handed to the manager for its first connection.
 */
export function importServers(selection: ImportSelection[], actor = "ui"): ImportResult {
  const db = getDb();
  const created: string[] = [];
  const createdSlugs: string[] = [];
  const skipped: string[] = [];
  const skippedReasons: Record<string, string> = {};
  const warnings: string[] = [];
  const needsAttention: Array<{ slug: string; reason: string }> = [];

  const taken = existingSlugs();
  const now = Date.now();
  const insertedIds: string[] = [];

  for (const entry of selection) {
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) {
      skipped.push("<unnamed>");
      skippedReasons["<unnamed>"] = "Missing server name.";
      continue;
    }

    const normalized = normalizeSelection(entry);
    if (!normalized) {
      skipped.push(name);
      skippedReasons[name] =
        (entry.transport ?? (entry.command ? "stdio" : "http")) === "stdio" ? "Missing command." : "Missing url.";
      continue;
    }

    let slug: string;
    if (entry.slug !== undefined && entry.slug !== null && String(entry.slug).trim() !== "") {
      const candidate = slugify(String(entry.slug));
      if (!isValidSlug(candidate)) {
        skipped.push(name);
        skippedReasons[name] = `Invalid slug "${entry.slug}": must match [a-z0-9]{1,12}.`;
        continue;
      }
      if (taken.has(candidate)) {
        skipped.push(name);
        skippedReasons[name] = `Slug "${candidate}" is already used by another upstream.`;
        continue;
      }
      slug = candidate;
    } else {
      slug = allocateSlug(name, taken);
    }
    taken.add(slug);

    const id = randomUUID();
    const isStdio = normalized.transport === "stdio";
    const envEnc = isStdio ? encodeEncRecord(normalized.env) : null;
    const headersEnc = isStdio ? null : encodeEncRecord(normalized.headers);

    db.insert(upstreams)
      .values({
        id,
        slug,
        name,
        description: `Imported from a client config (${actor})`,
        transport: normalized.transport,
        url: normalized.url,
        command: normalized.command,
        args: normalized.args && normalized.args.length > 0 ? normalized.args : null,
        cwd: normalized.cwd,
        envEnc,
        headersEnc,
        authType: normalized.authType,
        enabled: normalized.enabled,
        startMode: "always",
        status: "connecting",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    created.push(name);
    createdSlugs.push(slug);
    insertedIds.push(id);

    if (normalized.authType === "bearer" && Object.keys(normalized.headers).length === 0) {
      needsAttention.push({
        slug,
        reason: normalized.bearerTokenEnvVar
          ? `Bearer token expected from env var ${normalized.bearerTokenEnvVar}; it was unavailable at import time.`
          : "Bearer auth declared but no Authorization header was found; add the token in the server settings.",
      });
    }
    if (isStdio) {
      warnings.push(`${slug}: stdio servers execute third-party code inside the Switchboard container.`);
    }
  }

  if (insertedIds.length > 0) {
    logEvent({
      actor,
      type: "upstream.imported",
      message: `${insertedIds.length} upstream(s) imported from a client config`,
      data: { slugs: createdSlugs, names: created },
    });
    invalidateCatalog("upstream.imported");
    emitUiEvent("upstream.status", { ids: insertedIds, status: "connecting" });
    emitUiEvent("catalog.changed", { reason: "upstream.imported" });

    // Ask the manager to connect each new upstream. A failing manager must never break the import.
    if (hasUpstreamManager()) {
      const manager = getUpstreamManager();
      for (const id of insertedIds) {
        try {
          void Promise.resolve(manager.reload(id)).catch(() => undefined);
        } catch {
          /* manager unavailable (unit tests): it connects at the next startAll() */
        }
      }
    }
  }

  return { created, skipped, createdSlugs, skippedReasons, warnings, needsAttention };
}

// ---------------------------------------------------------------------------------------------
// Export (spec §6.4 + §9 GET /export?key=)
// ---------------------------------------------------------------------------------------------

export interface ExportUpstream {
  id: string;
  slug: string;
  name: string;
  transport: "http" | "sse" | "stdio";
  url: string | null;
  command: string | null;
  args: string[] | null;
  authType: "none" | "headers" | "bearer" | "oauth";
  toolCount: number;
  toolNames: string[];
}

export interface ExportKeyConfig {
  key: { id: string; name: string; prefix: string; scope: string; exposureMode: string };
  publicUrl: string;
  mcpUrl: string;
  upstreams: ExportUpstream[];
  /** Ready-to-paste snippets, exactly as spec §6.4 (shared with the key page). */
  snippets: {
    claudeCodeCommand: string;
    codexToml: string;
    mcpJson: string;
    genericJson: string;
  };
  totals: { upstreams: number; tools: number };
  generatedAt: number;
}

export interface ExportOptions {
  /** Plaintext secret, available only right after creation/rotation (never stored in clear). */
  secret?: string;
  /** When false, snippets use a placeholder instead of the real secret. */
  includeSecretInSnippets?: boolean;
}

const SECRET_PLACEHOLDER = "sk-sw-xxxxxxxx";

/**
 * Builds the spec §6.4 configuration for one key: the MCP URL, the snippets for Claude Code /
 * Codex / generic JSON, and the upstreams + tools that key may actually use.
 *
 * Consumed by `GET /export?key=` and by the Import page's "export" half. Snippet
 * generation is delegated to `lib/api/install.ts` so the key page and this export can never
 * drift apart.
 */
export function exportConfigForKey(keyId: string, options: ExportOptions = {}): ExportKeyConfig | null {
  const db = getDb();
  const key = db.select().from(apiKeys).where(eq(apiKeys.id, keyId)).get();
  if (!key) return null;

  const mcpUrl = mcpEndpoint();
  const secret = options.includeSecretInSnippets === false ? SECRET_PLACEHOLDER : options.secret;
  const shownSecret = secret ?? SECRET_PLACEHOLDER;

  // Only upstreams the key can actually reach belong in its install file.
  const access = effectiveAccessForKey(keyId);
  const allUpstreams = db.select().from(upstreams).all();
  const upstreamsOut: ExportUpstream[] = [];
  let toolTotal = 0;
  if (access) {
    for (const [upstreamId, entry] of Object.entries(access.upstreams)) {
      const row = allUpstreams.find((u) => u.id === upstreamId);
      if (!row) continue;
      toolTotal += entry.tools.length;
      upstreamsOut.push({
        id: row.id,
        slug: row.slug,
        name: row.name,
        transport: row.transport,
        url: row.url,
        command: row.command,
        args: (row.args as string[] | null) ?? null,
        authType: row.authType,
        toolCount: entry.tools.length,
        toolNames: entry.tools.slice().sort(),
      });
    }
  }
  upstreamsOut.sort((a, b) => a.slug.localeCompare(b.slug));

  const genericJson = JSON.stringify(
    {
      key: { name: key.name, prefix: key.prefix, scope: key.scope, exposureMode: key.exposureMode },
      mcpUrl,
      upstreams: upstreamsOut.map((u) => ({ slug: u.slug, name: u.name, transport: u.transport, tools: u.toolCount })),
      totals: { upstreams: upstreamsOut.length, tools: toolTotal },
    },
    null,
    2,
  );

  return {
    key: { id: key.id, name: key.name, prefix: key.prefix, scope: key.scope, exposureMode: key.exposureMode },
    publicUrl: publicBaseUrl(),
    mcpUrl,
    upstreams: upstreamsOut,
    snippets: {
      claudeCodeCommand: buildClaudeCodeCommand(shownSecret),
      codexToml: buildCodexConfig(),
      mcpJson: buildJsonSnippet(shownSecret),
      genericJson,
    },
    totals: { upstreams: upstreamsOut.length, tools: toolTotal },
    generatedAt: Date.now(),
  };
}
