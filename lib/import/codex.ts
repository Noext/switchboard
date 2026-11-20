/**
 * Codex config parser (`~/.codex/config.toml`, `[mcp_servers.*]`).
 *
 * Supported per-server keys, per the Codex docs:
 *   command, args, env (table or inline table), cwd, startup_timeout_sec,
 *   url, bearer_token_env_var, http_headers (table), env_http_headers.
 */

import { ImportParseError, buildParsedServer, isPlainObject } from "./claude-code";
import { parseToml, TomlError, type TomlValue } from "./toml";
import type { ParsedImport, ParsedServer } from "./types";

/** Codex allows "key = value" entries to also be camelCase in some versions; normalise keys. */
function normalizeKey(key: string): string {
  return key.replace(/-/g, "_").toLowerCase();
}

function getNormalized(table: Record<string, TomlValue>, name: string): TomlValue | undefined {
  if (table[name] !== undefined) return table[name];
  for (const [key, value] of Object.entries(table)) {
    if (normalizeKey(key) === normalizeKey(name)) return value;
  }
  return undefined;
}

function isTable(value: TomlValue | undefined): value is { [key: string]: TomlValue } {
  return isPlainObject(value);
}

export function parseCodexToml(text: string): ParsedImport {
  let document: Record<string, TomlValue>;
  try {
    document = parseToml(text) as Record<string, TomlValue>;
  } catch (error) {
    if (error instanceof TomlError) throw new ImportParseError(error.message, "codex");
    const message = error instanceof Error ? error.message : String(error);
    throw new ImportParseError(`Invalid TOML: ${message}`, "codex");
  }

  const warnings: string[] = [];
  const servers: ParsedServer[] = [];

  const rawServers = getNormalized(document, "mcp_servers");
  if (rawServers === undefined) {
    warnings.push(`No "[mcp_servers.*]" table found; is this a Codex config.toml file?`);
    return { format: "codex", servers, warnings };
  }
  if (!isTable(rawServers)) {
    warnings.push(`"mcp_servers" must be a table; it was ignored.`);
    return { format: "codex", servers, warnings };
  }

  for (const [name, raw] of Object.entries(rawServers)) {
    /** Warnings attached to this server row (the document sink is appended to as well). */
    const serverWarnings: string[] = [];
    if (!isTable(raw)) {
      warnings.push(`Server "${name}" is not a table and was ignored.`);
      continue;
    }

    const url = typeof getNormalized(raw, "url") === "string" ? (getNormalized(raw, "url") as string).trim() : "";
    const commandRaw = getNormalized(raw, "command");
    const command = typeof commandRaw === "string" ? commandRaw.trim() : "";
    const argsRaw = getNormalized(raw, "args");
    const cwdRaw = getNormalized(raw, "cwd");
    const bearerRaw = getNormalized(raw, "bearer_token_env_var");
    const bearerTokenEnvVar = typeof bearerRaw === "string" && bearerRaw.trim() !== "" ? bearerRaw.trim() : null;

    const envTable = getNormalized(raw, "env");
    const headersTable = getNormalized(raw, "http_headers");
    const envHttpHeaders = getNormalized(raw, "env_http_headers");

    // Codex uses "command" for stdio; "url" for streamable HTTP.
    const synthetic: Record<string, unknown> = {
      command: command || undefined,
      args: Array.isArray(argsRaw) ? argsRaw : [],
      cwd: typeof cwdRaw === "string" ? cwdRaw : undefined,
      env: isTable(envTable) ? envTable : undefined,
    };
    if (url) {
      synthetic.url = url;
      synthetic.type = "http";
      const headerMap: Record<string, string> = isTable(headersTable) ? { ...(headersTable as Record<string, string>) } : {};
      // env_http_headers maps header name -> env var name; the value comes from the environment.
      if (isTable(envHttpHeaders)) {
        for (const [headerName, envVarName] of Object.entries(envHttpHeaders)) {
          if (typeof envVarName !== "string") continue;
          const value = typeof process !== "undefined" ? process.env[envVarName] : undefined;
          if (value !== undefined) headerMap[headerName] = value;
          else {
            serverWarnings.push(
              `Server "${name}": env_http_headers["${headerName}"] refers to unset ${envVarName}.`,
            );
          }
        }
      }
      if (bearerTokenEnvVar) {
        const value = typeof process !== "undefined" ? process.env[bearerTokenEnvVar] : undefined;
        if (value !== undefined && value !== "") {
          headerMap["Authorization"] = `Bearer ${value}`;
        } else {
          serverWarnings.push(
            `Server "${name}" uses bearer_token_env_var=${bearerTokenEnvVar}; that variable is not set here, so no token was imported — add it after import or export the key for this server.`,
          );
        }
      }
      if (Object.keys(headerMap).length > 0) synthetic.headers = headerMap;
    }

    const parsed = buildParsedServer(name, synthetic, { format: "codex", scope: "global", warnings });
    if (!parsed) continue;
    parsed.bearerTokenEnvVar = bearerTokenEnvVar;
    if (bearerTokenEnvVar && parsed.authType === "none") {
      // Token could not be resolved but the intent is bearer auth.
      parsed.authType = "bearer";
    }
    if (parsed.transport !== "stdio" && Object.keys(parsed.env).length > 0) {
      serverWarnings.push(`Server "${name}" is remote; its [env] table was ignored.`);
      parsed.env = {};
    }
    for (const message of serverWarnings) {
      parsed.warnings.push(message);
      warnings.push(message);
    }
    servers.push(parsed);
  }

  if (servers.length === 0) warnings.push("No MCP server found in the [mcp_servers] table.");
  return { format: "codex", servers, warnings };
}