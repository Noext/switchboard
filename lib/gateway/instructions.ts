/**
 * Server `instructions` (spec §6.1): a short generated text listing the upstreams the key can
 * see, what each one is for, how to use the discovery meta-tools, and the one-line
 * `report_feedback` reminder (§6.5).
 *
 * This is the first thing an agent reads, so it must answer "what can I do here?" on its own.
 * An agent that has to guess keywords to discover its own surface will conclude the key is
 * nearly empty — the inventory and the enumeration hint are the fix for that.
 */

import { getCatalogSnapshot, type CatalogSnapshot } from "../catalog/catalog";
import { effectiveAccessForKey } from "../auth/grants";
import type { EffectiveAccess } from "../types";
import { visibleTools } from "./router";
import { isFeedbackToolAvailable } from "./feedbackTool";

export interface InstructionsInput {
  access: EffectiveAccess | null;
  snapshot?: CatalogSnapshot;
  discovery: boolean;
  feedbackEnabled: boolean;
  toolCount: number;
  /** Public tool names per upstream slug, used to seed discovery mode with real examples. */
  toolsByServer?: Array<{ slug: string; name: string; description: string | null; tools: string[] }>;
}

/** One-line role of an upstream: its admin description, else its name and tool count. */
function upstreamRole(description: string | null, name: string, toolCount: number): string {
  const base = description?.trim() || name;
  const tools = toolCount > 0 ? `${toolCount} outil${toolCount > 1 ? "s" : ""}` : "aucun outil";
  return `${base} (${tools})`;
}

/** Keeps the inventory readable: a summary line plus the most useful tool names per server. */
function examplesFor(tools: string[], max = 6): string {
  if (tools.length === 0) return "";
  const shown = tools.slice(0, max).map((name) => name.split("__")[1] ?? name);
  const more = tools.length > max ? `, … (${tools.length} au total)` : "";
  return ` [${shown.join(", ")}${more}]`;
}

export function buildInstructions(input: InstructionsInput): string {
  const snapshot = input.snapshot ?? getCatalogSnapshot();
  const access = input.access;
  const lines: string[] = [];

  lines.push(
    "Switchboard expose en un seul serveur MCP les serveurs MCP auxquels cette clé a accès. " +
      "Les outils sont nommés « <serveur>__<outil> » ; tu ne peux voir et appeler que ceux listés.",
  );

  const visible: string[] = [];
  if (access) {
    for (const [upstreamId, entry] of Object.entries(access.upstreams)) {
      if (!entry.hasAccess) continue;
      const view = snapshot.upstreams[upstreamId];
      if (!view) continue;
      const examples = input.toolsByServer?.find((s) => s.slug === view.slug)?.tools ?? [];
      visible.push(
        `- ${view.slug} : ${upstreamRole(view.description, view.name, entry.tools.length)}${examplesFor(examples)}`,
      );
    }
  }

  const totalTools = input.toolCount;
  if (visible.length > 0) {
    lines.push("");
    lines.push(
      `Serveurs MCP accessibles à cette clé (${totalTools} outil${totalTools > 1 ? "s" : ""} au total) :`,
    );
    lines.push(...visible);
  } else {
    lines.push("");
    lines.push(
      "Cette clé n'a accès à aucun serveur MCP pour l'instant. Il n'y a donc aucun outil à lister : " +
        "demande l'accès avec report_feedback (catégorie « access_needed »).",
    );
  }

  if (input.discovery && visible.length > 0) {
    lines.push("");
    lines.push(
      "Mode découverte : cette clé voit beaucoup d'outils, donc la liste complète n'est pas injectée " +
        "dans le contexte. Quatre méta-outils donnent accès à tout — commence par l'inventaire, ne " +
        "devine pas de mots-clés :",
    );
    lines.push("1. list_servers({}) — les serveurs accessibles et leur nombre d'outils.");
    lines.push(
      "2. search_tools({}) — SANS « query » (ou query=\"*\") renvoie la liste complète des outils " +
        "autorisés, groupée par serveur. Avec {query: \"mots clés\"}, recherche ciblée.",
    );
    lines.push("3. describe_tool({name}) — schéma d'entrée complet et annotations (fonctionne aussi pour les méta-outils).");
    lines.push("4. call_tool({name, arguments}) — exécute l'outil (mêmes règles d'accès qu'un appel direct).");
    lines.push(
      "N'appelle jamais un outil sans l'avoir décrit d'abord : les arguments doivent respecter le schéma renvoyé par describe_tool.",
    );
    if (input.toolsByServer && input.toolsByServer.length > 0) {
      lines.push(
        "Quelques noms d'outils disponibles pour amorcer : " +
          input.toolsByServer
            .flatMap((server) => server.tools.slice(0, 3))
            .slice(0, 12)
            .join(", ") +
          ". La liste complète s'obtient avec search_tools({}).",
      );
    }
  } else if (input.toolCount > 0) {
    lines.push("");
    lines.push(
      `${input.toolCount} outil${input.toolCount > 1 ? "s" : ""} au total. Les annotations (readOnlyHint, destructiveHint…) sont transmises telles quelles depuis chaque serveur.`,
    );
  }

  if (input.feedbackEnabled) {
    lines.push("");
    lines.push(
      "Outil toujours disponible : report_feedback — signale en une phrase à l'administrateur un outil en " +
        "erreur, manquant, une description trompeuse ou un accès refusé dont tu as besoin (jamais de secret dans le texte).",
    );
  }

  return lines.join("\n");
}

/** Collects the public tool names per accessible server, cheapest way for the examples line. */
export function toolsByServerForKey(access: EffectiveAccess | null): InstructionsInput["toolsByServer"] {
  if (!access) return [];
  let tools;
  try {
    tools = visibleTools(access.keyId);
  } catch {
    return [];
  }
  const bySlug = new Map<string, { slug: string; name: string; description: string | null; tools: string[] }>();
  const snapshot = getCatalogSnapshot();
  for (const entry of tools) {
    const view = snapshot.upstreams[entry.upstreamId];
    if (!view) continue;
    const bucket =
      bySlug.get(view.slug) ??
      { slug: view.slug, name: view.name, description: view.description, tools: [] as string[] };
    bucket.tools.push(entry.publicName);
    bySlug.set(view.slug, bucket);
  }
  return [...bySlug.values()].sort((a, b) => b.tools.length - a.tools.length);
}

/** Convenience wrapper: resolves the access and discovery flag for a key, then builds the text. */
export function instructionsFor(access: EffectiveAccess | null, discovery: boolean): string {
  const snapshot = getCatalogSnapshot();
  return buildInstructions({
    access,
    snapshot,
    discovery,
    feedbackEnabled: isFeedbackToolAvailable(),
    toolCount: access?.publicTools.length ?? 0,
    toolsByServer: toolsByServerForKey(access),
  });
}

/** Recomputes the instructions straight from the DB (used after an `initialize`). */
export function instructionsForKey(keyId: string, discovery: boolean): string {
  let access: EffectiveAccess | null = null;
  try {
    access = effectiveAccessForKey(keyId);
  } catch {
    access = null;
  }
  return instructionsFor(access, discovery);
}
