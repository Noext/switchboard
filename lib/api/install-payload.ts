import { getKey } from "../auth/keys";
import { buildEffectiveAccessView } from "./access-view";
import {
  buildClientConfig,
  buildClaudeCodeCommand,
  buildCodexConfig,
  buildInstallMarkdown,
  buildJsonSnippet,
  mcpEndpoint,
} from "./install";

/**
 * Everything the UI shows right after creating a key (spec §6.4 / §8 "clé affichée une fois"):
 * the MCP URL, the ready-to-paste snippets and the full INSTALL-<name>.md document.
 * The secret is only present when the caller just created/rotated it.
 */
export function buildInstallPayload(keyId: string, secret?: string | null) {
  const key = getKey(keyId);
  if (!key) return null;
  const view = buildEffectiveAccessView(keyId);
  const markdown = view ? buildInstallMarkdown(key, view) : "";
  return {
    url: mcpEndpoint(),
    keyName: key.name,
    prefix: key.prefix,
    secret: secret ?? null,
    markdown,
    json: buildJsonSnippet(secret ?? undefined),
    config: buildClientConfig({ secret: secret ?? undefined }),
    claudeCodeCommand: buildClaudeCodeCommand(secret ?? undefined),
    codexConfig: buildCodexConfig(),
    allowed: view
      ? view.upstreams
          .filter((u) => u.hasAccess)
          .map((u) => ({ slug: u.slug, name: u.name, tools: u.tools.map((t) => t.publicName) }))
      : [],
  };
}
