import { z } from "zod";
import { guardResponse, json, notFound, parseBody, requireAdmin, unavailable } from "@/lib/api/guard";
import { safeManager } from "@/lib/api/upstreams";
import { upstreamById } from "@/lib/api/serialize";
import { logCall } from "@/lib/logs";
import { emitUiEvent } from "@/lib/events";
import { getCatalogSnapshot } from "@/lib/catalog/catalog";

/**
 * POST /api/v1/upstreams/{id}/test    — tool test console (spec §8 "console de test")
 *   body: { tool: string, args?: Record<string, unknown> }
 *   -> { call: CallLogItem }   CallLogItem = { id, at, name, ok, denied, durationMs,
 *                                              argsPreview, resultPreview, errorCode }
 *
 * Runs ONE tool against the upstream through the manager (bypassing per-key grants, since this
 * is an admin action), records it in call_logs so it shows up in the Journal, and returns the
 * log row. `tool` may be the ORIGINAL upstream name (`create_issue`) or the public name
 * (`gh__create_issue`) — the slug prefix is stripped when it matches this upstream.
 *
 * This is NOT the connection test; that one is POST /api/v1/upstreams/test.
 */
const testSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  const row = upstreamById(id);
  if (!row) return notFound("Upstream not found");
  const parsed = await parseBody(req, testSchema);
  if (!parsed.ok) return parsed.response;

  const manager = safeManager();
  if (!manager) return unavailable("Upstream manager is not running");

  // Accept either the original tool name or the public "<slug>__<tool>" name.
  const view = getCatalogSnapshot().upstreams[id];
  const prefix = `${row.slug}__`;
  const toolName = parsed.data.tool.startsWith(prefix)
    ? parsed.data.tool.slice(prefix.length)
    : parsed.data.tool;

  const startedAt = Date.now();
  let ok = true;
  let errorCode: string | null = null;
  let result: unknown = null;
  try {
    result = await manager.callTool(id, toolName, parsed.data.args, {
      timeoutMs: parsed.data.timeoutMs ?? row.callTimeoutSeconds * 1000,
    });
    if ((result as { isError?: boolean } | null)?.isError) {
      ok = false;
      errorCode = "tool_error";
    }
  } catch (error) {
    ok = false;
    errorCode = "upstream_error";
    result = { error: error instanceof Error ? error.message : String(error) };
  }
  const durationMs = Date.now() - startedAt;

  const callId = logCall({
    keyId: null,
    upstreamId: id,
    kind: "tool",
    name: view?.toolPublicNames.get(toolName) ?? toolName,
    args: parsed.data.args,
    result,
    ok,
    errorCode,
    durationMs,
  });
  emitUiEvent("call.logged", { upstreamId: id, callId });

  return json({
    call: {
      id: callId,
      at: startedAt,
      name: view?.toolPublicNames.get(toolName) ?? toolName,
      ok,
      denied: false,
      durationMs,
      errorCode,
      // Preview fields are redacted and capped at 2 KB by the logging layer.
      argsPreview: previewText(parsed.data.args),
      resultPreview: previewText(result),
    },
    tool: toolName,
    result,
  });
}

function previewText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 2000 ? text.slice(0, 2000) + "…" : text;
  } catch {
    return null;
  }
}
