import { guardResponse, json, requireAdmin } from "@/lib/api/guard";
import { clampLimit, intParam } from "@/lib/api/util";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_SEVERITIES,
  FEEDBACK_STATUSES,
  feedbackStats,
  listFeedback,
} from "@/lib/feedback";

/**
 * GET /api/v1/feedback?status=&category=&severity=&key=&upstream=&tool=&search=&limit=&offset=
 *   -> { items, total, limit, offset, stats }
 *
 * Spec §9. Filters accept a single value or a comma-separated list; `key` is a key **id**
 * (that is what the Retours page filter carries). `stats` rides along so the dashboard badge
 * and the page counters need a single request.
 */
export const dynamic = "force-dynamic";

function split(value: string | null): string[] | undefined {
  if (!value) return undefined;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function invalid(
  kind: "status" | "category" | "severity",
  value: string,
  allowed: readonly string[],
): Response {
  return json({ error: `Invalid ${kind} "${value}"`, allowed: [...allowed] }, { status: 400 });
}

export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);

  const url = new URL(req.url);
  const statuses = split(url.searchParams.get("status"));
  const categories = split(url.searchParams.get("category"));
  const severities = split(url.searchParams.get("severity"));

  for (const value of statuses ?? []) {
    if (!(FEEDBACK_STATUSES as readonly string[]).includes(value)) {
      return invalid("status", value, FEEDBACK_STATUSES);
    }
  }
  for (const value of categories ?? []) {
    if (!(FEEDBACK_CATEGORIES as readonly string[]).includes(value)) {
      return invalid("category", value, FEEDBACK_CATEGORIES);
    }
  }
  for (const value of severities ?? []) {
    if (!(FEEDBACK_SEVERITIES as readonly string[]).includes(value)) {
      return invalid("severity", value, FEEDBACK_SEVERITIES);
    }
  }

  const result = listFeedback({
    status: statuses as never,
    category: categories as never,
    severity: severities as never,
    keyId: url.searchParams.get("key") ?? url.searchParams.get("keyId") ?? undefined,
    upstreamSlug: url.searchParams.get("upstream") ?? undefined,
    toolName: url.searchParams.get("tool") ?? undefined,
    search: url.searchParams.get("search") ?? undefined,
    limit: clampLimit(intParam(url, "limit"), 50, 200),
    offset: Math.max(0, intParam(url, "offset") ?? 0),
  });

  return json({ ...result, stats: feedbackStats() });
}
