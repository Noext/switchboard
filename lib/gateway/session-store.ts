import { and, eq, isNull, lt } from "drizzle-orm";
import { getDb } from "../db";
import { mcpSessions } from "../db/schema";
import { logger } from "../logs";
import type { ExposureMode } from "../types";

/**
 * Durable half of the session registry.
 *
 * The live objects (SDK `Server`, `StreamableHTTPServerTransport`, SSE sockets, in-flight
 * requests) are process memory and cannot be persisted. What is persisted is the session
 * *identity*: the id the client holds, its owner, timestamps and subscriptions. After a restart
 * the gateway rebuilds a live session from this row instead of answering 404, so open agents keep
 * working across a deploy.
 *
 * Rows are deleted when a session is genuinely closed (client DELETE, key revoked, idle timeout),
 * so a persisted row means "this session is still valid".
 */

export interface PersistedSession {
  sessionId: string;
  keyId: string;
  keyName: string;
  exposureMode: ExposureMode;
  ip: string | null;
  clientName: string | null;
  clientVersion: string | null;
  subscriptions: string[];
  createdAt: number;
  lastSeenAt: number;
}

/** Writes (or refreshes) a session row. Never throws: persistence must not break the gateway. */
export function saveSession(session: PersistedSession): void {
  try {
    const db = getDb();
    db.insert(mcpSessions)
      .values({
        sessionId: session.sessionId,
        keyId: session.keyId,
        keyName: session.keyName,
        exposureMode: session.exposureMode,
        ip: session.ip,
        clientName: session.clientName,
        clientVersion: session.clientVersion,
        subscriptions: session.subscriptions,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        closedAt: null,
        closeReason: null,
      })
      .onConflictDoUpdate({
        target: mcpSessions.sessionId,
        set: {
          keyName: session.keyName,
          exposureMode: session.exposureMode,
          ip: session.ip,
          clientName: session.clientName,
          clientVersion: session.clientVersion,
          subscriptions: session.subscriptions,
          lastSeenAt: session.lastSeenAt,
          closedAt: null,
          closeReason: null,
        },
      })
      .run();
  } catch (error) {
    logger.warn({ sessionId: session.sessionId, err: String(error) }, "session persist failed");
  }
}

/** Updates just the activity timestamp (called on every request; cheap single-row UPDATE). */
export function touchPersistedSession(sessionId: string, lastSeenAt = Date.now()): void {
  try {
    getDb()
      .update(mcpSessions)
      .set({ lastSeenAt })
      .where(eq(mcpSessions.sessionId, sessionId))
      .run();
  } catch (error) {
    logger.debug({ sessionId, err: String(error) }, "session touch failed");
  }
}

/** Records the MCP client identity reported during `initialize`. */
export function persistClientInfo(
  sessionId: string,
  info: { name?: string; version?: string } | null,
): void {
  try {
    getDb()
      .update(mcpSessions)
      .set({ clientName: info?.name ?? null, clientVersion: info?.version ?? null })
      .where(eq(mcpSessions.sessionId, sessionId))
      .run();
  } catch (error) {
    logger.debug({ sessionId, err: String(error) }, "client info persist failed");
  }
}

export function persistSubscriptions(sessionId: string, subscriptions: string[]): void {
  try {
    getDb().update(mcpSessions).set({ subscriptions }).where(eq(mcpSessions.sessionId, sessionId)).run();
  } catch (error) {
    logger.debug({ sessionId, err: String(error) }, "subscriptions persist failed");
  }
}

/** Reads one session if it is still valid (not closed). */
export function loadSession(sessionId: string): PersistedSession | null {
  try {
    const row = getDb()
      .select()
      .from(mcpSessions)
      .where(and(eq(mcpSessions.sessionId, sessionId), isNull(mcpSessions.closedAt)))
      .get();
    if (!row) return null;
    return {
      sessionId: row.sessionId,
      keyId: row.keyId,
      keyName: row.keyName,
      exposureMode: row.exposureMode,
      ip: row.ip,
      clientName: row.clientName,
      clientVersion: row.clientVersion,
      subscriptions: Array.isArray(row.subscriptions) ? row.subscriptions : [],
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
    };
  } catch (error) {
    logger.debug({ sessionId, err: String(error) }, "session load failed");
    return null;
  }
}

/** Deletes a session row (genuine close: DELETE, revocation, idle sweep). */
export function deleteSession(sessionId: string): void {
  try {
    getDb().delete(mcpSessions).where(eq(mcpSessions.sessionId, sessionId)).run();
  } catch (error) {
    logger.debug({ sessionId, err: String(error) }, "session delete failed");
  }
}

export function deleteSessionsForKey(keyId: string): void {
  try {
    getDb().delete(mcpSessions).where(eq(mcpSessions.keyId, keyId)).run();
  } catch (error) {
    logger.debug({ keyId, err: String(error) }, "key sessions delete failed");
  }
}

/** Removes rows whose session has been idle past the timeout (mirrors the memory janitor). */
export function pruneIdleSessions(cutoff: number): number {
  try {
    const stale = getDb()
      .select({ id: mcpSessions.sessionId })
      .from(mcpSessions)
      .where(lt(mcpSessions.lastSeenAt, cutoff))
      .all();
    if (stale.length === 0) return 0;
    for (const row of stale) {
      getDb().delete(mcpSessions).where(eq(mcpSessions.sessionId, row.id)).run();
    }
    return stale.length;
  } catch (error) {
    logger.debug({ err: String(error) }, "idle session prune failed");
    return 0;
  }
}

/** Test helper. */
export function clearPersistedSessionsForTests(): void {
  try {
    getDb().delete(mcpSessions).run();
  } catch {
    /* no DB in this test */
  }
}
