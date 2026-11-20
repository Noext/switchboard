import { readFileSync } from "node:fs";
import path from "node:path";

/** Public identity advertised by the gateway to MCP clients. */
export const SERVER_NAME = "switchboard";

function readPackageVersion(): string {
  try {
    const raw = readFileSync(path.join(process.cwd(), "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) return parsed.version;
  } catch {
    /* package.json unavailable (bundled/standalone image): fall through */
  }
  return "0.1.0";
}

/** Version reported in `initialize`, `/healthz` and the UI. */
export const SERVER_VERSION = process.env.SWITCHBOARD_VERSION ?? readPackageVersion();
