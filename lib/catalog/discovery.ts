import { getDbHandle } from "../db";
import { getCatalogSnapshot } from "./catalog";
import type { CatalogEntry } from "../types";
import { setupFts } from "../db/migrate";

/**
 * Full-text search over the *authorized* tools of one key.
 * Backed by SQLite FTS5 when available (spec §6.3); falls back to substring matching.
 */

export interface SearchHit {
  name: string;
  description: string;
  upstream: string;
  score: number;
}

let ftsReady = false;

export function ensureToolSearchIndex(): boolean {
  if (ftsReady) return true;
  try {
    const { sqlite } = getDbHandle();
    setupFts(sqlite);
    ftsReady = true;
    return true;
  } catch {
    return false;
  }
}

/** Rebuilds the FTS index from the current catalog (authorized filtering happens at query time). */
export function reindexToolSearch(): void {
  const snap = getCatalogSnapshot();
  const { sqlite } = getDbHandle();
  if (!ensureToolSearchIndex()) return;
  try {
    sqlite.exec("DELETE FROM tool_search_fts");
    const insert = sqlite.prepare(
      "INSERT INTO tool_search_fts (public_name, tool_name, description, params) VALUES (?, ?, ?, ?)",
    );
    const tx = sqlite.transaction(() => {
      for (const view of Object.values(snap.upstreams)) {
        for (const tool of view.tools) {
          if (!tool.enabled) continue;
          const params = extractParamNames(tool.definition?.inputSchema);
          insert.run(tool.publicName, tool.name, tool.description ?? "", params);
        }
      }
    });
    tx();
  } catch {
    /* ignore: fallback path used at query time */
  }
}

function extractParamNames(inputSchema: unknown): string {
  if (!inputSchema || typeof inputSchema !== "object") return "";
  const props = (inputSchema as { properties?: Record<string, unknown> }).properties;
  if (!props) return "";
  return Object.keys(props).join(" ");
}

/**
 * Searches the tools the key may see. Only authorized tools can ever be returned —
 * the allow-list is enforced here, not in the SQL.
 */
export function searchTools(query: string, limit: number, allowed: CatalogEntry[]): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const allowedByName = new Map(allowed.map((t) => [t.publicName, t]));

  const ftsResults = tryFts(q, limit * 3, allowedByName);
  if (ftsResults.length > 0) return ftsResults.slice(0, limit);

  return fallbackSearch(q, limit, allowed);
}

function tryFts(
  query: string,
  limit: number,
  allowed: Map<string, CatalogEntry>,
): SearchHit[] {
  if (!ensureToolSearchIndex()) return [];
  const { sqlite } = getDbHandle();
  const terms = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/["*]/g, ""))
    .filter(Boolean);
  if (terms.length === 0) return [];
  const ftsQuery = terms.map((t) => `"${t}"*`).join(" OR ");
  try {
    const rows = sqlite
      .prepare(
        `SELECT public_name, tool_name, description, bm25(tool_search_fts) AS score
         FROM tool_search_fts WHERE tool_search_fts MATCH ? ORDER BY score LIMIT ?`,
      )
      .all(ftsQuery, limit) as Array<{ public_name: string; tool_name: string; description: string; score: number }>;

    return rows
      .filter((r) => allowed.has(r.public_name))
      .map((r) => {
        const entry = allowed.get(r.public_name)!;
        return {
          name: r.public_name,
          description: entry.description ?? r.description ?? "",
          upstream: entry.upstreamSlug,
          score: -r.score,
        };
      });
  } catch {
    return [];
  }
}

function fallbackSearch(query: string, limit: number, allowed: CatalogEntry[]): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: SearchHit[] = [];
  for (const entry of allowed) {
    const haystack = `${entry.publicName} ${entry.name} ${entry.description ?? ""} ${extractParamNames(
      entry.definition?.inputSchema,
    )}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (!haystack.includes(term)) {
        score = -1;
        break;
      }
      score += entry.publicName.toLowerCase().includes(term) ? 3 : 1;
    }
    if (score < 0) continue;
    scored.push({
      name: entry.publicName,
      description: entry.description ?? "",
      upstream: entry.upstreamSlug,
      score,
    });
  }
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

/** Rough token estimate used by the UI's "effective view" panel (~4 chars per token). */
export function estimateTokens(entries: CatalogEntry[]): number {
  let chars = 0;
  for (const e of entries) {
    chars += e.publicName.length + (e.description?.length ?? 0) + JSON.stringify(e.definition ?? {}).length;
  }
  return Math.round(chars / 4);
}
