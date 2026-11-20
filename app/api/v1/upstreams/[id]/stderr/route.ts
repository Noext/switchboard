import { guardResponse, json, notFound, requireAdmin } from "@/lib/api/guard";
import { intParam } from "@/lib/api/util";
import { safeManager } from "@/lib/api/upstreams";
import { upstreamById } from "@/lib/api/serialize";
import { getRedactor } from "@/lib/redact";

/**
 * GET /api/v1/upstreams/{id}/stderr?lines=500
 *   -> { lines: string[], stderr: string[], count: number, runtime: boolean }
 *   (`lines` and `stderr` carry the same array; `stderr` matches the servers page tab.)
 *   Last N lines of the stdio process stderr ring (500 max), secrets masked by the redactor.
 *   `runtime:false` means the manager is not running (empty ring).
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const { id } = await ctx.params;
  const row = upstreamById(id);
  if (!row) return notFound("Upstream not found");

  const url = new URL(req.url);
  const limit = Math.min(Math.max(intParam(url, "lines", 500) ?? 500, 1), 500);
  const manager = safeManager();
  const raw = manager ? manager.getStderr(id) ?? [] : [];
  const redactor = getRedactor();
  const lines = raw.slice(-limit).map((line) => redactor.redact(line));
  return json({ lines, stderr: lines, count: lines.length, runtime: Boolean(manager) });
}
