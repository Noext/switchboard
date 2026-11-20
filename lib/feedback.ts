/**
 * Feedback persistence + business logic (spec §6.5 `report_feedback`).
 *
 * The gateway exposes a global `report_feedback` tool to every agent key; this module owns
 * validation, dedupe, rate limiting, masking and notification, plus the admin-side helpers used
 * by `/api/v1/feedback` and the Retours page.
 */

import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { config } from "./config";
import { getDb } from "./db";
import { apiKeys, callLogs, feedback as feedbackTable } from "./db/schema";
import { emitUiEvent } from "./events";
import { lastFailedCallFor, logEvent, recentCallsForSession } from "./logs";
import { getRedactor } from "./redact";
import { getSettings } from "./settings";
import { getCatalogSnapshot } from "./catalog/catalog";

// ---------------------------------------------------------------------------------------------
// Domain constants / types
// ---------------------------------------------------------------------------------------------

export const FEEDBACK_CATEGORIES = [
  "tool_error",
  "missing_tool",
  "access_needed",
  "bad_description",
  "slow",
  "bug",
  "other",
] as const;

export const FEEDBACK_SEVERITIES = ["low", "medium", "high", "blocking"] as const;

export const FEEDBACK_STATUSES = ["new", "acknowledged", "in_progress", "resolved", "wont_fix"] as const;

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];
export type FeedbackSeverity = (typeof FEEDBACK_SEVERITIES)[number];
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const REPORT_FEEDBACK_TOOL_NAME = "report_feedback";

/** Text shown to agents; §6.5 asks for a carefully written description. */
export const REPORT_FEEDBACK_TOOL_DESCRIPTION =
  "Signale à l'administrateur un problème rencontré avec un outil ou un serveur MCP de cette " +
  "passerelle : outil en erreur, outil manquant, accès refusé dont tu as besoin, description " +
  "trompeuse, lenteur. Utilise-le quand un problème t'empêche d'avancer ou se répète, pas pour " +
  "les erreurs que tu peux corriger toi-même (arguments invalides). Ne mets jamais de secret " +
  "(token, mot de passe) dans le texte.";

export interface FeedbackClientInfo {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

/** Agent-facing input, exactly as §6.5 specifies (snake_case on the wire). */
export const feedbackInputSchema = z.object({
  category: z.enum(FEEDBACK_CATEGORIES),
  severity: z.enum(FEEDBACK_SEVERITIES).default("medium"),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(4000),
  tool: z.string().trim().min(1).max(200).optional(),
  attempted_action: z.string().trim().max(2000).optional(),
  error_message: z.string().trim().max(4000).optional(),
});

/**
 * What a caller must pass: `severity` is optional here (it defaults to "medium"), which is the
 * §6.5 contract. After validation the field is always present — see {@link ParsedFeedbackInput}.
 */
export type FeedbackInput = z.input<typeof feedbackInputSchema>;

/** The validated shape, where `severity` is always resolved. */
export type ParsedFeedbackInput = z.output<typeof feedbackInputSchema>;

export interface FeedbackContext {
  keyId: string;
  sessionId?: string | null;
  clientInfo?: FeedbackClientInfo | null;
}

export interface RecordFeedbackResult {
  id: string;
  status: "recorded" | "merged";
  message: string;
  occurrences: number;
}

/** Thrown when a key exceeds the hourly feedback budget (§6.5: 20/hour/key). */
export class FeedbackRateLimitError extends Error {
  readonly code = "feedback_rate_limit";
  readonly limit: number;
  readonly retryAfterSeconds: number;

  constructor(limit: number, retryAfterSeconds: number) {
    super(
      `Rate limit exceeded: at most ${limit} feedback reports per hour per key. ` +
        `Try again in about ${Math.max(1, Math.ceil(retryAfterSeconds / 60))} minute(s).`,
    );
    this.name = "FeedbackRateLimitError";
    this.limit = limit;
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
  }
}

export interface FeedbackPatch {
  status?: FeedbackStatus;
  adminNote?: string | null;
}

type FeedbackRow = typeof feedbackTable.$inferSelect;
type CallLogRow = typeof callLogs.$inferSelect;

export interface FeedbackListItem extends FeedbackRow {
  keyName: string | null;
}

export interface FeedbackDetail extends FeedbackListItem {
  relatedCall: CallLogRow | null;
  recentCalls: CallLogRow[];
}

export interface FeedbackFilters {
  status?: FeedbackStatus | FeedbackStatus[];
  category?: FeedbackCategory | FeedbackCategory[];
  severity?: FeedbackSeverity | FeedbackSeverity[];
  keyId?: string;
  upstreamSlug?: string;
  toolName?: string;
  /** Free text on title + description. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface FeedbackListResult {
  items: FeedbackListItem[];
  total: number;
  limit: number;
  offset: number;
}

// ---------------------------------------------------------------------------------------------
// Rate limiting (per key, sliding 1h window, in-memory)
// ---------------------------------------------------------------------------------------------

const rateBuckets = new Map<string, number[]>();
const RATE_WINDOW_MS = 60 * 60 * 1000;

function checkRateLimit(keyId: string, now: number): void {
  const limit = config.defaults.feedbackRateLimitPerHour;
  const bucket = (rateBuckets.get(keyId) ?? []).filter((at) => at > now - RATE_WINDOW_MS);
  rateBuckets.set(keyId, bucket);
  if (bucket.length >= limit) {
    const oldest = bucket[0] ?? now;
    throw new FeedbackRateLimitError(limit, oldest + RATE_WINDOW_MS - now);
  }
}

function noteRateLimit(keyId: string, now: number): void {
  const bucket = (rateBuckets.get(keyId) ?? []).filter((at) => at > now - RATE_WINDOW_MS);
  bucket.push(now);
  rateBuckets.set(keyId, bucket);
}

/** Test/admin helper: clears the per-key sliding window. */
export function resetFeedbackRateLimit(keyId?: string): void {
  if (keyId === undefined) rateBuckets.clear();
  else rateBuckets.delete(keyId);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Case- and whitespace-insensitive title used for dedupe only (the stored title is untouched). */
export function normalizeTitle(title: string): string {
  return title.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function mask(text: string | null | undefined): string | null {
  if (text === undefined || text === null) return null;
  return getRedactor().redact(text);
}

/**
 * Resolves the upstream slug of a public tool name (`<slug>__<tool>`) without revealing
 * anything: unknown prefixes simply yield `null`.
 */
export function deriveUpstreamSlug(publicToolName: string | null | undefined): string | null {
  if (!publicToolName) return null;
  const idx = publicToolName.indexOf("__");
  if (idx <= 0) return null;
  const prefix = publicToolName.slice(0, idx);
  try {
    const snapshot = getCatalogSnapshot();
    if (snapshot.upstreamIdBySlug.has(prefix)) return prefix;
  } catch {
    /* catalog not ready: no slug */
  }
  return null;
}

export function isFeedbackEnabled(): boolean {
  try {
    return getSettings().feedbackEnabled;
  } catch {
    return true;
  }
}

function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 6);
}

// ---------------------------------------------------------------------------------------------
// Apprise notification (§6.5: high/blocking only, fire-and-forget)
// ---------------------------------------------------------------------------------------------

export interface ApprisePayload {
  urls: string;
  title: string;
  body: string;
}

/**
 * POSTs to the configured Apprise API. Never throws and never delays the caller.
 * Exported so tests can await/observe it.
 */
export async function sendAppriseNotification(payload: ApprisePayload): Promise<boolean> {
  try {
    const response = await fetch(payload.urls, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function maybeNotify(entry: {
  severity: FeedbackSeverity;
  category: FeedbackCategory;
  title: string;
  description: string;
  keyId: string;
  toolName?: string | null;
  upstreamSlug?: string | null;
}): void {
  if (entry.severity !== "high" && entry.severity !== "blocking") return;
  try {
    const settings = getSettings();
    if (!settings.appriseEnabled || !settings.appriseUrl) return;
    const db = getDb();
    const key = db.select({ name: apiKeys.name }).from(apiKeys).where(eq(apiKeys.id, entry.keyId)).get();
    const body = [
      `Gravité : ${entry.severity}`,
      `Catégorie : ${entry.category}`,
      `Clé : ${key?.name ?? entry.keyId}`,
      entry.upstreamSlug ? `Serveur : ${entry.upstreamSlug}` : null,
      entry.toolName ? `Outil : ${entry.toolName}` : null,
      "",
      entry.description,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
    void sendAppriseNotification({
      urls: settings.appriseUrl,
      title: `[Switchboard] ${entry.severity} — ${entry.title}`,
      body,
    }).catch(() => false);
  } catch {
    /* notification must never break feedback recording */
  }
}

// ---------------------------------------------------------------------------------------------
// Write path
// ---------------------------------------------------------------------------------------------

/**
 * Records a `report_feedback` call. Everything the agent must not control (keyId, sessionId,
 * clientInfo, timestamps) comes from the context, not the payload.
 *
 * @throws {FeedbackRateLimitError} when the key exceeds 20 reports/hour.
 * @throws {z.ZodError} when the payload is invalid.
 */
export function recordFeedback(input: FeedbackInput, ctx: FeedbackContext, now = Date.now()): RecordFeedbackResult {
  const parsed = feedbackInputSchema.parse(input);
  const db = getDb();

  checkRateLimit(ctx.keyId, now);

  const toolName = parsed.tool ?? null;
  const title = mask(parsed.title) ?? parsed.title;
  const description = mask(parsed.description) ?? parsed.description;
  const attemptedAction = mask(parsed.attempted_action);
  const errorMessage = mask(parsed.error_message);
  const normalized = normalizeTitle(title ?? parsed.title);

  // Auto-link the last failing call of this session on that tool (§6.5).
  let relatedCallId: string | null = null;
  if (toolName && ctx.sessionId) {
    try {
      const call = lastFailedCallFor(ctx.sessionId, toolName);
      relatedCallId = call?.id ?? null;
    } catch {
      relatedCallId = null;
    }
  }

  const upstreamSlug = deriveUpstreamSlug(toolName);

  // Dedupe: same key + same tool + same category + normalized title within the last 24h.
  const since = now - 24 * 60 * 60 * 1000;
  const candidates = db
    .select()
    .from(feedbackTable)
    .where(
      and(
        eq(feedbackTable.keyId, ctx.keyId),
        eq(feedbackTable.category, parsed.category),
        toolName === null ? sql`${feedbackTable.toolName} IS NULL` : eq(feedbackTable.toolName, toolName),
        gte(feedbackTable.lastOccurrenceAt, since),
      ),
    )
    .orderBy(desc(feedbackTable.lastOccurrenceAt))
    .all();

  const merged = candidates.find((row) => normalizeTitle(row.title) === normalized) ?? null;

  if (merged) {
    const nextStatus: FeedbackStatus = merged.status === "resolved" ? "new" : (merged.status as FeedbackStatus);
    db.update(feedbackTable)
      .set({
        occurrences: sql`${feedbackTable.occurrences} + 1`,
        lastOccurrenceAt: now,
        updatedAt: now,
        status: nextStatus,
        resolvedAt: nextStatus === "new" ? null : merged.resolvedAt,
        relatedCallId: merged.relatedCallId ?? relatedCallId,
        upstreamSlug: merged.upstreamSlug ?? upstreamSlug,
      })
      .where(eq(feedbackTable.id, merged.id))
      .run();

    noteRateLimit(ctx.keyId, now);
    emitUiEvent("feedback.changed", { id: merged.id, status: "merged" });
    return {
      id: merged.id,
      status: "merged",
      occurrences: merged.occurrences + 1,
      message: `Merci, retour enregistré (#${shortId(merged.id)}). Continue ta tâche autrement si possible.`,
    };
  }

  const id = randomUUID();
  db.insert(feedbackTable)
    .values({
      id,
      createdAt: now,
      updatedAt: now,
      keyId: ctx.keyId,
      sessionId: ctx.sessionId ?? null,
      clientInfo: (ctx.clientInfo ?? null) as unknown as Record<string, unknown> | null,
      category: parsed.category,
      severity: parsed.severity,
      title,
      description,
      upstreamSlug,
      toolName,
      attemptedAction,
      errorMessage,
      relatedCallId,
      occurrences: 1,
      lastOccurrenceAt: now,
      status: "new",
      adminNote: null,
      resolvedAt: null,
    })
    .run();

  noteRateLimit(ctx.keyId, now);
  logEvent({
    actor: "agent",
    type: "feedback.created",
    message: `Feedback from key ${ctx.keyId}: ${parsed.category} / ${parsed.severity} — ${title}`,
    data: { id, keyId: ctx.keyId, category: parsed.category, severity: parsed.severity, tool: toolName },
  });
  maybeNotify({
    severity: parsed.severity,
    category: parsed.category,
    title,
    description,
    keyId: ctx.keyId,
    toolName,
    upstreamSlug,
  });
  emitUiEvent("feedback.changed", { id, status: "recorded", severity: parsed.severity });

  return {
    id,
    status: "recorded",
    occurrences: 1,
    message: `Merci, retour enregistré (#${shortId(id)}). Continue ta tâche autrement si possible.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Read path (admin API / UI)
// ---------------------------------------------------------------------------------------------

function assertStatus(status: string): asserts status is FeedbackStatus {
  if (!(FEEDBACK_STATUSES as readonly string[]).includes(status)) {
    throw new Error(`Invalid feedback status: ${status}`);
  }
}

function buildWhere(filters: FeedbackFilters): SQL | undefined {
  const conditions: SQL[] = [];
  const asArray = <T extends string>(value: T | T[] | undefined): T[] | undefined =>
    value === undefined ? undefined : Array.isArray(value) ? value : [value];

  const statuses = asArray(filters.status);
  if (statuses?.length) {
    for (const s of statuses) assertStatus(s);
    conditions.push(inArray(feedbackTable.status, statuses));
  }
  const categories = asArray(filters.category);
  if (categories?.length) conditions.push(inArray(feedbackTable.category, categories));
  const severities = asArray(filters.severity);
  if (severities?.length) conditions.push(inArray(feedbackTable.severity, severities));
  if (filters.keyId) conditions.push(eq(feedbackTable.keyId, filters.keyId));
  if (filters.upstreamSlug) conditions.push(eq(feedbackTable.upstreamSlug, filters.upstreamSlug));
  if (filters.toolName) conditions.push(eq(feedbackTable.toolName, filters.toolName));
  if (filters.search) {
    const escaped = filters.search.replace(/[%_\\]/g, (m) => "\\" + m);
    const needle = "%" + escaped + "%";
    const clause = or(like(feedbackTable.title, needle), like(feedbackTable.description, needle));
    if (clause) conditions.push(clause);
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** Lists feedback with the filters exposed by `GET /api/v1/feedback` (spec §9). */
export function listFeedback(filters: FeedbackFilters = {}): FeedbackListResult {
  const db = getDb();
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);
  const where = buildWhere(filters);

  const rows = db
    .select()
    .from(feedbackTable)
    .where(where)
    .orderBy(desc(feedbackTable.lastOccurrenceAt), desc(feedbackTable.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  const total =
    db
      .select({ n: sql<number>`count(*)` })
      .from(feedbackTable)
      .where(where)
      .get()?.n ?? 0;

  const keyNames = new Map(db.select({ id: apiKeys.id, name: apiKeys.name }).from(apiKeys).all().map((k) => [k.id, k.name]));

  return {
    items: rows.map((row) => ({ ...row, keyName: keyNames.get(row.keyId) ?? null })),
    total,
    limit,
    offset,
  };
}

/** One feedback entry with the linked call + recent calls of the same session (§8 fiche). */
export function getFeedback(id: string, recentLimit = 10): FeedbackDetail | null {
  const db = getDb();
  const row = db.select().from(feedbackTable).where(eq(feedbackTable.id, id)).get();
  if (!row) return null;
  const key = db.select({ name: apiKeys.name }).from(apiKeys).where(eq(apiKeys.id, row.keyId)).get();
  const relatedCall = row.relatedCallId
    ? (db.select().from(callLogs).where(eq(callLogs.id, row.relatedCallId)).get() ?? null)
    : null;
  const recentCalls = row.sessionId ? recentCallsForSession(row.sessionId, recentLimit) : [];
  return {
    ...row,
    keyName: key?.name ?? null,
    relatedCall,
    recentCalls,
  };
}

export interface FeedbackStats {
  byStatus: Record<FeedbackStatus, number>;
  open: number;
  /** Unresolved feedback counts per severity (dashboard card, §8). */
  openBySeverity: Record<FeedbackSeverity, number>;
}

/** Aggregate for the dashboard: unprocessed feedback by severity (§8). */
export function feedbackStats(): FeedbackStats {
  const db = getDb();
  const byStatus: Record<FeedbackStatus, number> = {
    new: 0,
    acknowledged: 0,
    in_progress: 0,
    resolved: 0,
    wont_fix: 0,
  };
  const openBySeverity: Record<FeedbackSeverity, number> = { low: 0, medium: 0, high: 0, blocking: 0 };
  for (const row of db.select({ status: feedbackTable.status, severity: feedbackTable.severity }).from(feedbackTable).all()) {
    byStatus[row.status as FeedbackStatus] += 1;
    if (row.status !== "resolved" && row.status !== "wont_fix") {
      openBySeverity[row.severity as FeedbackSeverity] += 1;
    }
  }
  return {
    byStatus,
    open: byStatus.new + byStatus.acknowledged + byStatus.in_progress,
    openBySeverity,
  };
}

// ---------------------------------------------------------------------------------------------
// Admin mutations
// ---------------------------------------------------------------------------------------------

function applyStatusFields(
  patch: FeedbackPatch,
  now: number,
): { status?: FeedbackStatus; adminNote?: string | null; resolvedAt?: number | null; updatedAt: number } {
  const fields: { status?: FeedbackStatus; adminNote?: string | null; resolvedAt?: number | null; updatedAt: number } = {
    updatedAt: now,
  };
  if (patch.status !== undefined) {
    assertStatus(patch.status);
    fields.status = patch.status;
    fields.resolvedAt = patch.status === "resolved" || patch.status === "wont_fix" ? now : null;
  }
  if (patch.adminNote !== undefined) {
    fields.adminNote = patch.adminNote === null ? null : (mask(patch.adminNote) ?? patch.adminNote);
  }
  return fields;
}

/** PATCH /feedback/{id}: status and/or admin note. Logs an event on status changes. */
export function updateFeedback(
  id: string,
  patch: FeedbackPatch,
  actor = "ui",
  now = Date.now(),
): FeedbackListItem | null {
  const db = getDb();
  const before = db.select().from(feedbackTable).where(eq(feedbackTable.id, id)).get();
  if (!before) return null;

  const fields = applyStatusFields(patch, now);
  db.update(feedbackTable).set(fields).where(eq(feedbackTable.id, id)).run();

  if (patch.status !== undefined && patch.status !== before.status) {
    logEvent({
      actor,
      type: "feedback.status_changed",
      message: `Feedback #${shortId(id)}: ${before.status} → ${patch.status}`,
      data: { id, before: before.status, after: patch.status, adminNote: fields.adminNote ?? before.adminNote },
    });
  } else {
    logEvent({
      actor,
      type: "feedback.updated",
      message: `Feedback #${shortId(id)} updated`,
      data: { id, patch },
    });
  }

  emitUiEvent("feedback.changed", { id, status: fields.status ?? before.status });
  const key = db.select({ name: apiKeys.name }).from(apiKeys).where(eq(apiKeys.id, before.keyId)).get();
  const updated = db.select().from(feedbackTable).where(eq(feedbackTable.id, id)).get();
  return updated ? { ...updated, keyName: key?.name ?? null } : null;
}

/** POST /feedback/bulk {ids, status}. */
export function bulkUpdateStatus(
  ids: string[],
  status: FeedbackStatus,
  actor = "ui",
  now = Date.now(),
): { updated: number; ids: string[] } {
  assertStatus(status);
  const unique = Array.from(new Set(ids.filter((id) => typeof id === "string" && id.length > 0)));
  if (unique.length === 0) return { updated: 0, ids: [] };
  const db = getDb();
  const resolvedAt = status === "resolved" || status === "wont_fix" ? now : null;
  const result = db
    .update(feedbackTable)
    .set({ status, resolvedAt, updatedAt: now })
    .where(inArray(feedbackTable.id, unique))
    .run();
  const updated = Number((result as { changes?: number }).changes ?? unique.length);

  logEvent({
    actor,
    type: "feedback.bulk_updated",
    message: `${updated} feedback entr${updated > 1 ? "ies" : "y"} → ${status}`,
    data: { ids: unique, status },
  });
  emitUiEvent("feedback.changed", { ids: unique, status });
  return { updated, ids: unique };
}
