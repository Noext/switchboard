import pino from "pino";
import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { config } from "./config";
import { getDb } from "./db";
import { callLogs, events } from "./db/schema";
import { getRedactor } from "./redact";

export const logger = pino({
  level: config.logLevel,
  base: { app: "switchboard" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

const PREVIEW_LIMIT = 2048;

export interface CallLogInput {
  keyId?: string | null;
  sessionId?: string | null;
  upstreamId?: string | null;
  kind: string;
  name: string;
  args?: unknown;
  result?: unknown;
  ok: boolean;
  errorCode?: string | null;
  denied?: boolean;
  durationMs?: number | null;
}

export function preview(value: unknown, keyId?: string | null): string | null {
  if (value === undefined || value === null) return null;
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return null;
  const redacted = getRedactor().redact(text, keyId ?? undefined);
  return redacted.length > PREVIEW_LIMIT ? redacted.slice(0, PREVIEW_LIMIT) + "…" : redacted;
}

export function logCall(input: CallLogInput): string {
  const db = getDb();
  const id = randomUUID();
  db.insert(callLogs)
    .values({
      id,
      at: Date.now(),
      keyId: input.keyId ?? null,
      sessionId: input.sessionId ?? null,
      upstreamId: input.upstreamId ?? null,
      kind: input.kind,
      name: input.name,
      argsPreview: preview(input.args, input.keyId ?? undefined),
      resultPreview: preview(input.result, input.keyId ?? undefined),
      ok: input.ok,
      errorCode: input.errorCode ?? null,
      denied: input.denied ?? false,
      durationMs: input.durationMs ?? null,
    })
    .run();
  return id;
}

export interface EventInput {
  actor: string;
  type: string;
  message: string;
  upstreamId?: string | null;
  data?: unknown;
}

export function logEvent(input: EventInput): void {
  const db = getDb();
  db.insert(events)
    .values({
      id: randomUUID(),
      at: Date.now(),
      actor: input.actor,
      type: input.type,
      upstreamId: input.upstreamId ?? null,
      message: getRedactor().redact(input.message),
      data: input.data === undefined ? null : (getRedactor().redactDeep(input.data) as any),
    })
    .run();
  logger.info({ type: input.type, actor: input.actor, upstreamId: input.upstreamId }, input.message);
}

/** Retention: 30 days or 100k rows, whichever is hit first. Called hourly. */
export function pruneCallLogs(): void {
  const db = getDb();
  const cutoff = Date.now() - config.defaults.callLogRetentionDays * 86_400_000;
  db.delete(callLogs).where(lt(callLogs.at, cutoff)).run();
  const count = db.select({ n: sql<number>`count(*)` }).from(callLogs).get()?.n ?? 0;
  if (count > config.defaults.callLogRetentionRows) {
    const overflow = count - config.defaults.callLogRetentionRows;
    const ids = db.select({ id: callLogs.id }).from(callLogs).orderBy(callLogs.at).limit(overflow).all();
    if (ids.length) {
      const chunk = 500;
      for (let i = 0; i < ids.length; i += chunk) {
        const slice = ids.slice(i, i + chunk).map((r) => r.id);
        db.delete(callLogs).where(sql`${callLogs.id} IN (${sql.join(slice.map((id) => sql`${id}`), sql`, `)})`).run();
      }
    }
  }
}

export function recentCallsForSession(sessionId: string, limit = 20) {
  const db = getDb();
  return db
    .select()
    .from(callLogs)
    .where(eq(callLogs.sessionId, sessionId))
    .orderBy(desc(callLogs.at))
    .limit(limit)
    .all();
}

export function lastFailedCallFor(sessionId: string, toolName: string) {
  const db = getDb();
  const rows = db
    .select()
    .from(callLogs)
    .where(and(eq(callLogs.sessionId, sessionId), eq(callLogs.name, toolName), eq(callLogs.ok, false)))
    .orderBy(desc(callLogs.at))
    .limit(1)
    .all();
  return rows[0] ?? null;
}
