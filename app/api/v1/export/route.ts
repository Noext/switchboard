import { getKey } from "@/lib/auth/keys";
import { badRequest, guardResponse, json, notFound, requireAdmin } from "@/lib/api/guard";
import {
  buildClientConfig,
  buildClaudeCodeCommand,
  buildCodexConfig,
  buildJsonSnippet,
  mcpEndpoint,
  KEY_PLACEHOLDER,
} from "@/lib/api/install";
import { buildEffectiveAccessView } from "@/lib/api/access-view";

/**
 * GET /api/v1/export?key=<keyId>&format=json|claude|codex
 *   spec §9 "GET /export?key=": the config an agent using that key would see.
 *   -> { key: { id, name, prefix }, url, mcpUrl, config: { mcpServers: ... },
 *        snippets: { claudeCodeCommand, codexToml, mcpJson }, allowed: [...], totals, note }
 *   The secret is NEVER exported — the placeholder `sk-sw-xxxxxxxx…` is used and the response
 *   says so in `note`. Use POST /keys to create a key (returns the secret once) if one is lost.
 *   ?format=claude returns an old-style `claude mcp add` snippet; ?format=codex a TOML block.
 */
export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const url = new URL(req.url);
  const keyId = url.searchParams.get("key");
  if (!keyId) return badRequest("Missing ?key=<keyId>");
  const key = getKey(keyId);
  if (!key) return notFound("Key not found");
  const view = buildEffectiveAccessView(keyId);
  const config = buildClientConfig({ secret: KEY_PLACEHOLDER });

  const format = url.searchParams.get("format");
  if (format === "codex") {
    const toml = [
      "[mcp_servers.switchboard]",
      `url = "${mcpEndpoint()}"`,
      'bearer_token_env_var = "SWITCHBOARD_KEY"',
    ].join("\n");
    return new Response(toml, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }

  const endpoint = mcpEndpoint();
  return json({
    key: { id: key.id, name: key.name, prefix: key.prefix, exposureMode: key.exposureMode },
    url: endpoint,
    // Both names are provided: `mcpUrl` for the UI snippets panel, `url` for API consumers.
    mcpUrl: endpoint,
    config,
    snippets: {
      claudeCodeCommand: buildClaudeCodeCommand(),
      codexToml: buildCodexConfig(),
      mcpJson: buildJsonSnippet(),
    },
    allowed: view
      ? view.upstreams
          .filter((u) => u.hasAccess)
          .map((u) => ({ slug: u.slug, name: u.name, tools: u.tools.map((t) => t.publicName), prompts: u.prompts, resources: u.resources }))
      : [],
    totals: view?.totals ?? { upstreams: 0, tools: 0, prompts: 0, resources: 0, estimatedTokens: 0 },
    note: "The key secret is only returned once, at creation/rotation. Replace sk-sw-xxxxxxxx… with it.",
  });
}
