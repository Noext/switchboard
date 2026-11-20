/** Formatting helpers shared by server and client components (pure, no node imports). */

export function relTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 0) {
    const future = -diff;
    if (future < 60_000) return "dans " + Math.round(future / 1000) + " s";
    if (future < 3_600_000) return "dans " + Math.round(future / 60_000) + " min";
    if (future < 86_400_000) return "dans " + Math.round(future / 3_600_000) + " h";
    return "dans " + Math.round(future / 86_400_000) + " j";
  }
  if (diff < 5_000) return "à l'instant";
  if (diff < 60_000) return "il y a " + Math.round(diff / 1000) + " s";
  if (diff < 3_600_000) return "il y a " + Math.round(diff / 60_000) + " min";
  if (diff < 86_400_000) return "il y a " + Math.round(diff / 3_600_000) + " h";
  if (diff < 30 * 86_400_000) return "il y a " + Math.round(diff / 86_400_000) + " j";
  return new Date(ts).toLocaleDateString("fr-FR");
}

export function absTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString("fr-FR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function dateOnly(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("fr-FR", { year: "numeric", month: "2-digit", day: "2-digit" });
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return Math.round(ms) + " ms";
  if (ms < 60_000) return (ms / 1000).toFixed(1) + " s";
  return Math.floor(ms / 60_000) + " min " + Math.round((ms % 60_000) / 1000) + " s";
}

export function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("fr-FR");
}

/** Rough token estimate used by the effective-access preview (spec §8): ~chars/4. */
export function estimateTokens(chars: number): number {
  return Math.max(1, Math.round(chars / 4));
}

export function truncate(text: string, max = 90): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export function keyStatus(k: { revokedAt: number | null; expiresAt: number | null }): "active" | "revoked" | "expired" {
  if (k.revokedAt) return "revoked";
  if (k.expiresAt && k.expiresAt <= Date.now()) return "expired";
  return "active";
}

export function pct(part: number, total: number): string {
  if (!total) return "0 %";
  return Math.round((part / total) * 100) + " %";
}
