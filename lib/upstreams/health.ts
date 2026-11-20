import { config } from "../config";
import { logger } from "../logs";

/**
 * Health/lifecycle loop for one upstream (spec §4.3):
 *
 * - `ping` every 60 s on HTTP/SSE upstreams;
 * - reconnect with exponential backoff 1 s → 60 s;
 * - after 5 consecutive failures the upstream is marked `error` and retried every 5 min;
 * - lazy stdio upstreams are stopped after `idleStopMinutes` without activity.
 */

/** Backoff sequence from the spec: 1 s → 60 s. */
export const BACKOFF_SEQUENCE_MS: readonly number[] = config.defaults.reconnectBackoffMs;

/** Consecutive failures tolerated before switching to the slow retry loop. */
export const MAX_FAILURES_BEFORE_ERROR = 5;

/** Retry interval once the upstream has been declared `error`. */
export const ERROR_RETRY_MS = 5 * 60_000;

/** Delay before retry number `attempt` (1-based). */
export function backoffDelay(attempt: number, sequence: readonly number[] = BACKOFF_SEQUENCE_MS): number {
  if (attempt <= 0) return 0;
  const index = Math.min(attempt - 1, sequence.length - 1);
  return sequence[index] ?? sequence[sequence.length - 1] ?? 60_000;
}

/** Human readable "next retry" hint for the UI. */
export function describeRetry(delayMs: number): string {
  if (delayMs < 1000) return `retry in ${delayMs} ms`;
  const seconds = Math.round(delayMs / 1000);
  if (seconds < 60) return `retry in ${seconds} s`;
  return `retry in ${Math.round(seconds / 60)} min`;
}

export interface HealthHooks {
  /** Probes liveness. Returning false counts as a failure. */
  ping(): Promise<boolean>;
  /** Attempts a full reconnect; resolve true on success. */
  reconnect(): Promise<boolean>;
  /** Called with the number of consecutive failures when a retry is scheduled. */
  onReconnectScheduled?(failures: number, delayMs: number): void;
  /** Called once when the failure count crosses MAX_FAILURES_BEFORE_ERROR. */
  onGaveUp?(failures: number): void;
  /** Called after a successful reconnect. */
  onRecovered?(): void;
  /** Called when a lazy stdio upstream has been idle for the configured time. */
  onIdle?(): void | Promise<void>;
}

export interface HealthMonitorOptions {
  hooks: HealthHooks;
  /** 0 disables the ping loop (stdio upstreams). */
  pingIntervalMs?: number;
  idleStopMs?: number;
  backoffSequence?: readonly number[];
  maxFailures?: number;
  errorRetryMs?: number;
  pingTimeoutMs?: number;
  /** Granularity of the idle check. */
  idleCheckIntervalMs?: number;
  now?: () => number;
}

type Timer = ReturnType<typeof setTimeout>;

export class HealthMonitor {
  private options: HealthMonitorOptions;
  private hooks: HealthHooks;
  private pingTimer: Timer | null = null;
  private reconnectTimer: Timer | null = null;
  private idleTimer: Timer | null = null;
  private started = false;
  private stopped = true;
  private gaveUp = false;

  consecutiveFailures = 0;
  lastActivityAt: number;
  lastPingAt: number | null = null;
  nextRetryAt: number | null = null;

  constructor(options: HealthMonitorOptions) {
    this.options = options;
    this.hooks = options.hooks;
    this.lastActivityAt = this.now();
  }

  private now(): number {
    return this.options.now ? this.options.now() : Date.now();
  }

  private get maxFailures(): number {
    return this.options.maxFailures ?? MAX_FAILURES_BEFORE_ERROR;
  }

  private get errorRetryMs(): number {
    return this.options.errorRetryMs ?? ERROR_RETRY_MS;
  }

  get isRunning(): boolean {
    return this.started && !this.stopped;
  }

  /** Starts the background loops. Safe to call twice. */
  start(): void {
    if (this.isRunning) return;
    this.started = true;
    this.stopped = false;
    this.lastActivityAt = this.now();
    this.armPing();
    this.armIdle();
  }

  /** Stops all loops and pending retries. */
  stop(): void {
    this.stopped = true;
    this.clearPing();
    this.clearReconnect();
    this.clearIdle();
  }

  /** Records activity (used by the lazy idle stop). */
  noteActivity(): void {
    this.lastActivityAt = this.now();
  }

  /** A successful connect/ping: clears the failure streak. */
  markHealthy(): void {
    const hadFailures = this.consecutiveFailures > 0;
    this.consecutiveFailures = 0;
    this.gaveUp = false;
    this.nextRetryAt = null;
    this.clearReconnect();
    if (hadFailures) this.hooks.onRecovered?.();
    if (this.isRunning) this.armPing();
  }

  /**
   * Records a failure and schedules a reconnect. After `maxFailures` consecutive
   * failures the upstream is considered `error` and retried every 5 min.
   */
  reportFailure(reason?: string): void {
    this.consecutiveFailures += 1;
    const failures = this.consecutiveFailures;
    const crossed = failures >= this.maxFailures && !this.gaveUp;
    if (crossed) {
      this.gaveUp = true;
      this.hooks.onGaveUp?.(failures);
    }
    const delay = this.gaveUp ? this.errorRetryMs : backoffDelay(failures, this.options.backoffSequence ?? BACKOFF_SEQUENCE_MS);
    logger.debug({ failures, delay, reason }, "upstream reconnect scheduled");
    this.scheduleReconnect(delay, failures);
  }

  /** Schedules a reconnect explicitly (e.g. after a transport close). */
  scheduleReconnect(delayMs?: number, failures = this.consecutiveFailures): void {
    this.clearReconnect();
    const delay = delayMs ?? (this.gaveUp ? this.errorRetryMs : backoffDelay(Math.max(1, failures), this.options.backoffSequence ?? BACKOFF_SEQUENCE_MS));
    this.nextRetryAt = this.now() + delay;
    this.hooks.onReconnectScheduled?.(failures, delay);
    const timer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.runReconnect();
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
    this.reconnectTimer = timer;
  }

  private async runReconnect(): Promise<void> {
    if (this.stopped) return;
    this.nextRetryAt = null;
    let ok = false;
    try {
      ok = await this.hooks.reconnect();
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, "upstream reconnect threw");
      ok = false;
    }
    if (this.stopped) return;
    if (ok) {
      this.markHealthy();
    } else {
      this.reportFailure("reconnect failed");
    }
  }

  private armPing(): void {
    this.clearPing();
    const interval = this.options.pingIntervalMs ?? config.defaults.healthPingIntervalMs;
    if (interval <= 0) return;
    const timer = setTimeout(() => {
      this.pingTimer = null;
      void this.runPing();
    }, interval);
    if (typeof timer.unref === "function") timer.unref();
    this.pingTimer = timer;
  }

  private async runPing(): Promise<void> {
    if (this.stopped) return;
    this.lastPingAt = this.now();
    let ok = false;
    try {
      ok = await this.withTimeout(this.hooks.ping(), this.options.pingTimeoutMs ?? 10_000);
    } catch {
      ok = false;
    }
    if (this.stopped) return;
    if (ok) {
      // A ping only clears the streak when we had failed before.
      if (this.consecutiveFailures > 0) this.markHealthy();
      else this.armPing();
    } else {
      this.reportFailure("ping failed");
    }
  }

  private armIdle(): void {
    this.clearIdle();
    const idleStopMs = this.options.idleStopMs ?? 0;
    if (idleStopMs <= 0) return;
    const checkEvery = this.options.idleCheckIntervalMs ?? Math.min(30_000, Math.max(1000, Math.floor(idleStopMs / 4)));
    const timer = setTimeout(() => this.checkIdle(), checkEvery);
    if (typeof timer.unref === "function") timer.unref();
    this.idleTimer = timer;
  }

  private checkIdle(): void {
    this.idleTimer = null;
    if (this.stopped) return;
    const idleStopMs = this.options.idleStopMs ?? 0;
    const idleFor = this.now() - this.lastActivityAt;
    if (idleStopMs > 0 && idleFor >= idleStopMs) {
      void Promise.resolve(this.hooks.onIdle?.()).catch(() => undefined);
      // The manager decides whether to keep the loop alive; re-arm so a later
      // activity can trigger another stop cycle.
    }
    this.armIdle();
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: Timer | null = null;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
