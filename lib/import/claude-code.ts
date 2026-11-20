/**
 * Claude Code config parser: `.mcp.json` (project scope) and `~/.claude.json`
 * (global `mcpServers` plus a `projects[<path>].mcpServers` entry per project).
 */

import type { ImportAuthType, ImportTransport, ParsedImport, ParsedServer } from "./types";

interface RawServerConfig {
  type?: string;
  transport?: string;
  url?: string;
  command?: string;
  args?: unknown;
  cwd?: string;
  env?: unknown;
  headers?: unknown;
  [key: string]: unknown;
}

export class ImportParseError extends Error {
  readonly format: string;

  constructor(message: string, format: string) {
    super(message);
    this.name = "ImportParseError";
    this.format = format;
  }
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Coerces a headers/env object into a `Record<string,string>`, dropping non-scalar values. */
export function toStringRecord(value: unknown, kind: "env" | "headers"): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined) continue;
    if (typeof raw === "string") out[key] = raw;
    else if (typeof raw === "number" || typeof raw === "boolean") out[key] = String(raw);
  }
  return out;
}

function toStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.map((v) => (typeof v === "string" ? v : String(v)));
  return out.length > 0 ? out : [];
}

/** `Authorization: Bearer …` in a header map means the upstream is bearer-authenticated. */
export function headersUseBearer(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(
    ([key, value]) => key.toLowerCase() === "authorization" && /^bearer\s+/i.test(value.trim()),
  );
}

interface BuildOptions {
  format: ParsedImport["format"];
  scope: string;
  projects?: string[];
  /**
   * Document-level sink. A server that is dropped (no url/command) never reaches the caller, so
   * its warnings must be collected here or they would be lost.
   */
  warnings?: string[];
}

/** Turns one raw `mcpServers[name]` entry into a ParsedServer, collecting warnings. */
export function buildParsedServer(name: string, raw: unknown, options: BuildOptions): ParsedServer | null {
  const warnings: string[] = [];
  /** Records a warning on the server when it survives, and on the document either way. */
  const warn = (message: string): void => {
    warnings.push(message);
    options.warnings?.push(message);
  };
  if (!isPlainObject(raw)) {
    warn(`Server "${name}" is not an object and was ignored.`);
    return null;
  }
  const config = raw as RawServerConfig;
  const headers = toStringRecord(config.headers, "headers");
  const env = toStringRecord(config.env, "env");
  const args = toStringArray(config.args);
  const declaredType = typeof config.type === "string" ? config.type.toLowerCase() : undefined;
  const declaredTransport = typeof config.transport === "string" ? config.transport.toLowerCase() : undefined;

  const url = typeof config.url === "string" && config.url.trim() !== "" ? config.url.trim() : null;
  const command = typeof config.command === "string" && config.command.trim() !== "" ? config.command.trim() : null;
  const cwd = typeof config.cwd === "string" && config.cwd.trim() !== "" ? config.cwd.trim() : null;

  let transport: ImportTransport;
  if (declaredType === "sse" || declaredTransport === "sse") transport = "sse";
  else if (url) transport = declaredType === "sse" ? "sse" : "http";
  else if (command) transport = "stdio";
  else {
    warn(`Server "${name}" has neither "url" nor "command"; it was ignored.`);
    return null;
  }

  if (transport !== "stdio" && !url) {
    warn(`Server "${name}" declares a remote transport but no url; it was ignored.`);
    return null;
  }
  if (transport === "stdio" && !command) {
    warn(`Server "${name}" declares stdio but no command; it was ignored.`);
    return null;
  }
  if (transport !== "stdio" && command) {
    warn(`Server "${name}" declares both a url and a command; the remote transport was kept.`);
  }
  if (transport === "stdio" && Object.keys(headers).length > 0) {
    warn(`Server "${name}" is stdio but declares HTTP headers; they were dropped.`);
  }

  let authType: ImportAuthType = "none";
  if (transport !== "stdio" && Object.keys(headers).length > 0) {
    authType = headersUseBearer(headers) ? "bearer" : "headers";
  }
  if (declaredType === "oauth" || config.oauth === true) authType = "oauth";

  const finalHeaders = transport === "stdio" ? {} : headers;

  return {
    name,
    transport,
    url: transport === "stdio" ? null : url,
    command: transport === "stdio" ? command : null,
    args: transport === "stdio" ? (args ?? []) : null,
    cwd: transport === "stdio" ? cwd : null,
    env: transport === "stdio" ? env : {},
    headers: finalHeaders,
    bearerTokenEnvVar: null,
    authType,
    enabled: config.disabled === true ? false : true,
    projects: options.projects ?? [],
    warnings,
    scope: options.scope,
  };
}

/** Merges duplicate declarations of the same server name (global + projects). */
function mergeDuplicates(servers: ParsedServer[]): { servers: ParsedServer[]; warnings: string[] } {
  const warnings: string[] = [];
  const byName = new Map<string, ParsedServer>();
  for (const server of servers) {
    const existing = byName.get(server.name);
    if (!existing) {
      byName.set(server.name, server);
      continue;
    }
    const sameConnection =
      existing.transport === server.transport &&
      existing.url === server.url &&
      existing.command === server.command &&
      JSON.stringify(existing.args) === JSON.stringify(server.args) &&
      JSON.stringify(existing.env) === JSON.stringify(server.env) &&
      JSON.stringify(existing.headers) === JSON.stringify(server.headers);
    if (sameConnection) {
      existing.projects = Array.from(new Set([...existing.projects, ...server.projects]));
      continue;
    }
    warnings.push(
      `Server "${server.name}" is declared twice with different settings (kept ${existing.scope}, ignored ${server.scope}).`,
    );
  }
  return { servers: [...byName.values()], warnings };
}

export function parseClaudeCodeJson(text: string): ParsedImport {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ImportParseError(`Invalid JSON: ${message}`, "claude-code");
  }
  if (!isPlainObject(document)) {
    throw new ImportParseError("Expected a JSON object at the top level", "claude-code");
  }

  const warnings: string[] = [];
  const servers: ParsedServer[] = [];

  // 1. Global mcpServers (~/.claude.json root or .mcp.json).
  const globalServers = document.mcpServers;
  if (isPlainObject(globalServers)) {
    for (const [name, raw] of Object.entries(globalServers)) {
      const parsed = buildParsedServer(name, raw, { format: "claude-code", scope: "global", warnings });
      if (parsed) servers.push(parsed);
    }
  } else if (globalServers !== undefined) {
    warnings.push(`"mcpServers" must be an object; it was ignored.`);
  }

  // 2. Per-project entries (~/.claude.json "projects").
  if (isPlainObject(document.projects)) {
    for (const [projectPath, projectRaw] of Object.entries(document.projects)) {
      if (!isPlainObject(projectRaw)) continue;
      const projectServers = projectRaw.mcpServers;
      if (!isPlainObject(projectServers)) continue;
      for (const [name, raw] of Object.entries(projectServers)) {
        const parsed = buildParsedServer(name, raw, {
          format: "claude-code",
          scope: `project:${projectPath}`,
          projects: [projectPath],
          warnings,
        });
        if (parsed) servers.push(parsed);
      }
    }
  }

  const merged = mergeDuplicates(servers);
  const combinedWarnings = [...warnings, ...merged.warnings];
  if (merged.servers.length === 0) {
    combinedWarnings.push(
      `No MCP server found: expected an "mcpServers" object (optionally with "projects[].mcpServers").`,
    );
  }
  return { format: "claude-code", servers: merged.servers, warnings: combinedWarnings };
}