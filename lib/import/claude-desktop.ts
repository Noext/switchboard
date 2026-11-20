/**
 * Claude Desktop config parser (`claude_desktop_config.json`).
 *
 * Shape: `{ "mcpServers": { "<name>": { "command", "args", "env" } } }`. Desktop only supports
 * stdio servers; a `url` entry is accepted with a warning because some forks add remote support.
 */

import { ImportParseError, buildParsedServer, isPlainObject } from "./claude-code";
import type { ParsedImport, ParsedServer } from "./types";

export const CLAUDE_DESKTOP_DEFAULT_PATHS = [
  "~/Library/Application Support/Claude/claude_desktop_config.json",
  "%APPDATA%\\Claude\\claude_desktop_config.json",
  "~/.config/Claude/claude_desktop_config.json",
] as const;

export function parseClaudeDesktopJson(text: string): ParsedImport {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ImportParseError(`Invalid JSON: ${message}`, "claude-desktop");
  }
  if (!isPlainObject(document)) {
    throw new ImportParseError("Expected a JSON object at the top level", "claude-desktop");
  }

  const warnings: string[] = [];
  const servers: ParsedServer[] = [];
  const rawServers = document.mcpServers;

  if (rawServers === undefined) {
    warnings.push(`No "mcpServers" key found; is this a claude_desktop_config.json file?`);
  } else if (!isPlainObject(rawServers)) {
    warnings.push(`"mcpServers" must be an object; it was ignored.`);
  } else {
    for (const [name, raw] of Object.entries(rawServers)) {
      const parsed = buildParsedServer(name, raw, { format: "claude-desktop", scope: "global", warnings });
      if (!parsed) continue;
      if (parsed.transport !== "stdio") {
        parsed.warnings.push(
          `Claude Desktop normally runs stdio servers only; "${name}" was kept as ${parsed.transport} — verify it works.`,
        );
      }
      if (parsed.transport === "stdio" && parsed.env["PATH"] !== undefined) {
        parsed.warnings.push(
          `"${name}" declares PATH in env; Switchboard injects its own PATH/HOME, so this value is kept but may be overridden.`,
        );
      }
      servers.push(parsed);
    }
  }

  if (servers.length === 0 && warnings.length === 0) {
    warnings.push("No MCP server found in this file.");
  }
  return { format: "claude-desktop", servers, warnings };
}
