import { getSettings, updateSettings } from "@/lib/settings";
import { guardResponse, json, parseBody, requireAdmin } from "@/lib/api/guard";
import { settingsPatchSchema } from "@/lib/api/schemas";
import { config } from "@/lib/config";
import { isMasterKeyFromFile, masterKeyExists } from "@/lib/crypto";
import { emitUiEvent } from "@/lib/events";
import { logEvent } from "@/lib/logs";

/**
 * GET /api/v1/settings
 *   -> { settings: AppSettings, env: { publicUrl, dataDir, port, logLevel },
 *        masterKey: { present, fromFile } }
 *   The admin password and master key VALUE are never returned.
 *
 * PATCH /api/v1/settings   body: subset of AppSettings
 *   -> { settings: AppSettings }
 */
export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  return json({
    settings: getSettings(),
    env: {
      publicUrl: config.publicUrl,
      dataDir: config.dataDir,
      port: config.port,
      logLevel: config.logLevel,
      isProd: config.isProd,
    },
    masterKey: { present: masterKeyExists(), fromFile: isMasterKeyFromFile() },
  });
}

export async function PATCH(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const parsed = await parseBody(req, settingsPatchSchema);
  if (!parsed.ok) return parsed.response;
  const before = getSettings();
  const settings = updateSettings(parsed.data);
  logEvent({
    actor: guard.actor,
    type: "settings.updated",
    message: "Settings updated",
    data: { changed: Object.keys(parsed.data), before, after: settings },
  });
  emitUiEvent("catalog.changed", { reason: "settings" });
  return json({ settings });
}
