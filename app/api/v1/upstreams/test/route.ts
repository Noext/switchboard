import { json, parseBody, requireAdmin, guardResponse, unavailable } from "@/lib/api/guard";
import { upstreamTestSchema } from "@/lib/api/schemas";
import { mergeHeaders, safeManager } from "@/lib/api/upstreams";
import { decodeSecretMap } from "@/lib/api/secrets";
import { upstreamById } from "@/lib/api/serialize";
import type { TestConfigInput } from "@/lib/upstreams/types";

/**
 * POST /api/v1/upstreams/test  ("Tester la connexion", spec §8)
 *   body: { id } | { transport, url|command, args, cwd, env, headers, bearerToken, authType }
 *   -> 200 { ok: true, serverInfo, capabilities, toolCount, tools: [{name, description}] }
 *   -> 200 { ok: false, error }                     (connection failed — not an HTTP error)
 *   -> 503 { error }                               (upstream manager not running)
 *
 * When `id` is given the stored upstream is tested with its DECRYPTED secrets; the secrets are
 * never included in the response.
 */
export async function POST(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const parsed = await parseBody(req, upstreamTestSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  const manager = safeManager();
  if (!manager) return unavailable("Upstream manager is not running");

  let candidate: TestConfigInput;
  if (body.id) {
    const row = upstreamById(body.id);
    if (!row) return json({ ok: false, error: "Upstream not found" }, { status: 404 });
    const headers = decodeSecretMap(row.headersEnc);
    const env = decodeSecretMap(row.envEnc);
    candidate = {
      transport: row.transport,
      url: row.url ?? undefined,
      command: row.command ?? undefined,
      args: row.args ?? undefined,
      cwd: row.cwd ?? undefined,
      env: env ?? undefined,
      headers: headers ?? undefined,
      authType: row.authType,
    };
  } else {
    if (!body.transport) return json({ ok: false, error: "transport is required when testing a candidate config" }, { status: 400 });
    const headers = mergeHeaders(body.headers, body.bearerToken);
    candidate = {
      transport: body.transport,
      url: body.url ?? undefined,
      command: body.command ?? undefined,
      args: body.args ?? undefined,
      cwd: body.cwd ?? undefined,
      env: body.env ?? undefined,
      headers: headers ?? undefined,
      authType: body.authType,
    };
  }

  try {
    const result = await manager.testConfig(candidate);
    return json({
      ok: result.ok,
      serverInfo: result.serverInfo ?? null,
      capabilities: result.capabilities ?? null,
      toolCount: result.tools?.length ?? 0,
      tools: (result.tools ?? []).slice(0, 100).map((tool) => ({ name: tool.name, description: tool.description ?? null })),
      error: result.error ?? null,
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : "Connection test failed" });
  }
}
