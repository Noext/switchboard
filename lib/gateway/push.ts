/**
 * Catalog/key change propagation to open sessions (spec §5, §7.2, §6.1).
 *
 * On every catalog change (upstream ready/lost, listing changed, override changed, grant/role
 * changed…) and on key lifecycle events, we recompute each key's effective view and compare it
 * with the last one we pushed. Only keys whose view actually changed get a
 * `notifications/{tools,prompts,resources}/list_changed` on each of their sessions.
 *
 * Everything is debounced (500 ms) so a burst of DB writes (adding an upstream, importing…) sends
 * one notification per key instead of dozens, and the "< 5 s" acceptance criterion (§12.2) holds.
 */

import { onCatalogChanged } from "../catalog/catalog";
import { reindexToolSearch } from "../catalog/discovery";
import { onKeyLifecycle } from "../auth/keys";
import { logger } from "../logs";
import { isFeedbackToolAvailable } from "./feedbackTool";
import { isDiscoveryMode, visiblePrompts, visibleResourceTemplates, visibleResources, visibleTools } from "./router";
import { closeSessionsForKey, sessionsForKey, type GatewaySession } from "./sessions";

const DEBOUNCE_MS = 500;

export type ListChangedChannel = "tools" | "prompts" | "resources";

/** What a key can currently see; used to detect changes. */
interface ViewSnapshot {
  tools: string[];
  prompts: string[];
  resources: string[];
  /**
   * Whether tools are rendered through the discovery meta-tools. Not a visible name, but switching
   * modes (exposureMode edit, threshold change) does change the list the client receives, so it
   * must trigger a `tools/list_changed`.
   */
  discovery: boolean;
  /** `report_feedback` is listed on/off through the global Settings switch (§6.5). */
  feedback: boolean;
}

const lastView = new Map<string, ViewSnapshot>();

/** The exposure mode a key currently uses (sessions carry it; a key normally has one value). */
function exposureModeFor(keyId: string): string | undefined {
  return sessionsForKey(keyId)[0]?.exposureMode;
}

function readView(keyId: string): ViewSnapshot {
  const tools = visibleTools(keyId);
  const exposureMode = exposureModeFor(keyId);
  return {
    tools: tools.map((entry) => entry.publicName),
    prompts: visiblePrompts(keyId).map((entry) => entry.publicName),
    resources: [
      ...visibleResources(keyId).map((entry) => entry.publicName),
      ...visibleResourceTemplates(keyId).map((entry) => entry.publicName),
    ],
    discovery: exposureMode !== undefined ? isDiscoveryMode(exposureMode, tools.length) : false,
    feedback: isFeedbackToolAvailable(),
  };
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function notify(session: GatewaySession, channel: ListChangedChannel): Promise<void> {
  try {
    if (channel === "tools") await session.server.sendToolListChanged();
    else if (channel === "prompts") await session.server.sendPromptListChanged();
    else await session.server.sendResourceListChanged();
  } catch (error) {
    // A dead session must not stop the notification for the others.
    logger.debug({ sessionId: session.sessionId, channel, err: String(error) }, "list_changed delivery failed");
  }
}

/**
 * Diffs one key's view and pushes the matching notifications to all its sessions.
 * Returns the channels that were announced.
 */
export async function pushKeyChanges(keyId: string): Promise<ListChangedChannel[]> {
  const next = readView(keyId);
  const previous = lastView.get(keyId);
  lastView.set(keyId, next);
  if (!previous) return [];

  const changed: ListChangedChannel[] = [];
  // In discovery mode the client sees the meta-tools, so a change of the meta-tool set (feedback
  // switch) or of the mode itself is a tools change too.
  if (!sameList(previous.tools, next.tools) || previous.discovery !== next.discovery || previous.feedback !== next.feedback) {
    changed.push("tools");
  }
  if (!sameList(previous.prompts, next.prompts)) changed.push("prompts");
  if (!sameList(previous.resources, next.resources)) changed.push("resources");
  if (changed.length === 0) return [];

  const sessions = sessionsForKey(keyId);
  for (const channel of changed) {
    for (const session of sessions) await notify(session, channel);
  }
  logger.info({ keyId, channels: changed, sessions: sessions.length }, "list_changed pushed");
  return changed;
}

/** Records the current view of a key (at session open), so the first diff is meaningful. */
export function primeKeyView(keyId: string): void {
  if (lastView.has(keyId)) return;
  try {
    lastView.set(keyId, readView(keyId));
  } catch {
    /* catalog/DB not ready: the next push will prime it */
  }
}

/** Re-primes a key's view unconditionally (after an exposureMode change, for instance). */
export function refreshKeyView(keyId: string): void {
  try {
    lastView.set(keyId, readView(keyId));
  } catch {
    lastView.delete(keyId);
  }
}

export function forgetKeyView(keyId: string): void {
  lastView.delete(keyId);
}

let timer: NodeJS.Timeout | null = null;
let pending = false;

async function flush(): Promise<void> {
  pending = false;
  // The FTS index used by discovery mode must follow the catalog (§6.3).
  try {
    reindexToolSearch();
  } catch {
    /* FTS unavailable: searchTools falls back to LIKE */
  }
  for (const keyId of [...lastView.keys()]) {
    if (sessionsForKey(keyId).length === 0) {
      forgetKeyView(keyId);
      continue;
    }
    try {
      await pushKeyChanges(keyId);
    } catch (error) {
      logger.warn({ keyId, err: String(error) }, "catalog push failed for key");
    }
  }
}

function scheduleFlush(): void {
  if (pending) return;
  pending = true;
  timer = setTimeout(() => {
    timer = null;
    void flush().catch((error) => logger.warn({ err: String(error) }, "catalog push flush failed"));
  }, DEBOUNCE_MS);
  if (typeof timer.unref === "function") timer.unref();
}

/** Runs the debounce window immediately (tests, and shutdown). */
export async function flushPushNow(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  await flush();
}

/** Whether a key currently sees the discovery meta-tools (used by the UI preview). */
export function discoveryModeFor(keyId: string, exposureMode: string): boolean {
  return isDiscoveryMode(exposureMode, visibleTools(keyId).length);
}

let unsubscribers: Array<() => void> = [];

/** Starts listening to catalog and key changes. Idempotent. */
export function startCatalogPush(): void {
  if (unsubscribers.length > 0) return;
  unsubscribers = [
    onCatalogChanged(() => {
      scheduleFlush();
    }),
    onKeyLifecycle((event) => {
      if (event.type === "revoked") {
        // Spec §6.1: a revocation closes the key's sessions immediately.
        forgetKeyView(event.keyId);
        void closeSessionsForKey(event.keyId, "key-revoked").catch((error) =>
          logger.warn({ keyId: event.keyId, err: String(error) }, "could not close sessions for revoked key"),
        );
        return;
      }
      if (event.type === "updated" && !event.affectsAccess) return;
      scheduleFlush();
    }),
  ];
}

export function stopCatalogPush(): void {
  for (const unsubscribe of unsubscribers) {
    try {
      unsubscribe();
    } catch {
      /* already gone */
    }
  }
  unsubscribers = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  pending = false;
  lastView.clear();
}

/** Test helper: exposes the keys currently tracked. */
export function trackedKeyIds(): string[] {
  return [...lastView.keys()];
}
