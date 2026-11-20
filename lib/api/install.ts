import { config } from "../config";
import { getSettings } from "../settings";
import type { EffectiveAccessView } from "./access-view";
import type { KeyRecord } from "../auth/keys";

/** Public base URL: the runtime setting wins over the env default (spec §8 Paramètres). */
export function publicBaseUrl(): string {
  const fromSettings = getSettings().publicUrl;
  return (fromSettings || config.publicUrl).replace(/\/$/, "");
}

export function mcpEndpoint(): string {
  return `${publicBaseUrl()}/mcp`;
}

export const KEY_PLACEHOLDER = "sk-sw-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

/**
 * Client configuration for one key, in the `.mcp.json` shape (spec §6.4 / §8 "export").
 * The secret itself is never retrievable — a placeholder is emitted.
 */
export function buildClientConfig(options: { name?: string; secret?: string | null } = {}) {
  const name = options.name ?? "switchboard";
  const secret = options.secret ?? KEY_PLACEHOLDER;
  return {
    mcpServers: {
      [name]: {
        type: "http" as const,
        url: mcpEndpoint(),
        headers: { Authorization: `Bearer ${secret}` },
      },
    },
  };
}

export function buildCodexConfig(): string {
  return [
    "# Codex (~/.codex/config.toml)",
    "[mcp_servers.switchboard]",
    `url = "${mcpEndpoint()}"`,
    'bearer_token_env_var = "SWITCHBOARD_KEY"',
    "",
  ].join("\n");
}

export function buildClaudeCodeCommand(secret = KEY_PLACEHOLDER): string {
  return [
    "# Claude Code (scope user = every project on this machine)",
    `claude mcp add --scope user --transport http switchboard ${mcpEndpoint()} \\`,
    `  --header "Authorization: Bearer ${secret}"`,
  ].join("\n");
}

export function buildJsonSnippet(secret = KEY_PLACEHOLDER): string {
  return JSON.stringify(buildClientConfig({ secret }), null, 2);
}

function accessSummaryLines(view: EffectiveAccessView): string[] {
  const lines: string[] = [];
  const withAccess = view.upstreams.filter((u) => u.hasAccess);
  if (!withAccess.length) {
    lines.push("_Aucun accès pour l'instant : la clé ne voit aucun outil. Demande à l'administrateur._");
    return lines;
  }
  for (const upstream of withAccess) {
    lines.push(`### \`${upstream.slug}\` — ${upstream.name}`);
    if (upstream.status !== "ready") {
      lines.push(`> Statut du serveur : \`${upstream.status}\` (les outils peuvent être indisponibles).`);
    }
    if (upstream.tools.length) {
      lines.push("Outils autorisés :");
      for (const tool of upstream.tools) lines.push(`- \`${tool.publicName}\` — ${tool.description ?? "(sans description)"}`);
    } else {
      lines.push("Outils autorisés : aucun.");
    }
    if (upstream.prompts) {
      lines.push(upstream.prompts.length ? `Prompts : ${upstream.prompts.map((p) => `\`${p.publicName}\``).join(", ")}` : "Prompts : aucun.");
    }
    if (upstream.resources) {
      lines.push(
        upstream.resources.length
          ? `Ressources : ${upstream.resources.map((r) => `\`${r.publicName}\``).join(", ")}`
          : "Ressources : aucune.",
      );
    }
    if (upstream.removedByDeny.length) {
      lines.push(`Retirés pour cette clé : ${upstream.removedByDeny.map((t) => `\`${t}\``).join(", ")}`);
    }
    lines.push("");
  }
  return lines;
}

/**
 * `INSTALL-<nom>.md` (spec §6.4): URL, key placeholder, snippets and the exact list of MCPs
 * and tools the key may use. Ready to hand to an agent, which runs it itself.
 */
export function buildInstallMarkdown(key: KeyRecord, view: EffectiveAccessView): string {
  const url = mcpEndpoint();
  const lines: string[] = [];
  lines.push(`# INSTALL-${key.name}.md`, "");
  lines.push(
    "Ce fichier installe la passerelle MCP **Switchboard** pour cet agent. Il contient tout le nécessaire :",
    "l'URL du point d'accès, comment fournir la clé, et la liste exacte des MCP et outils autorisés.",
    "",
  );
  lines.push("## 1. Point d'accès", "");
  lines.push(`- URL MCP (streamable HTTP) : \`${url}\``, `- Nom de la clé : \`${key.name}\` (préfixe \`${key.prefix}…\`)`, "");
  lines.push("## 2. Clé API", "");
  lines.push(
    "Le secret de cette clé **n'est affiché qu'une seule fois**, au moment de sa création. Il n'est pas",
    "récupérable depuis ce fichier ni depuis l'interface. Si tu ne l'as pas, demande à l'administrateur",
    `de le régénérer (rotation), puis remplace \`${KEY_PLACEHOLDER}\` dans les extraits ci-dessous.`,
    "",
  );
  lines.push("Le secret s'envoie dans l'en-tête \`Authorization: Bearer sk-sw-…\`.", "");
  lines.push("## 3. Installation", "", "### Claude Code", "", "```bash", buildClaudeCodeCommand(), "```", "");
  lines.push("### Codex", "", "```toml", buildCodexConfig().trimEnd(), "```", "");
  lines.push("### JSON générique (.mcp.json)", "", "```json", buildJsonSnippet(), "```", "");
  lines.push(
    "### Conteneurs et sandboxes",
    "",
    "Injecte la clé par variable d'environnement au démarrage du conteneur, puis référence-la dans la config :",
    "",
    "```bash",
    `export SWITCHBOARD_KEY="${KEY_PLACEHOLDER}"`,
    "```",
    "",
  );
  lines.push("## 4. Droits de cette clé", "");
  lines.push(
    `Mode d'exposition : \`${view.exposureMode}\`. Total : ${view.totals.upstreams} serveur(s), ` +
      `${view.totals.tools} outil(s), ${view.totals.prompts} prompt(s), ${view.totals.resources} ressource(s) ` +
      `(≈ ${view.totals.estimatedTokens} tokens estimés).`,
    "",
  );
  lines.push(...accessSummaryLines(view));
  lines.push("## 5. Rappels", "");
  lines.push(
    "- Les noms d'outils sont préfixés par le nom court du serveur : \`<slug>__<outil>\`.",
    "- Tout ce qui n'est pas listé ci-dessus est **invisible et non appelable** (erreur identique à un outil inexistant).",
    "- Un outil qui rencontre un problème peut être signalé à l'administrateur avec l'outil **\`report_feedback\`**, toujours disponible.",
    "- Ne mets jamais de secret (token, mot de passe) dans les arguments d'un outil ni dans un retour.",
    "",
  );
  return lines.join("\n");
}
