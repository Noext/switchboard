import { and, eq, notInArray } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ClientCapabilities, Implementation } from "@modelcontextprotocol/sdk/types.js";
import { invalidateCatalog } from "../catalog/catalog";
import { buildPublicName } from "../catalog/naming";
import { getDb, schema } from "../db";
import { emitUiEvent } from "../events";
import { logger } from "../logs";
import { getRedactor } from "../redact";
import type { UpstreamStatus } from "../types";
import {
  CLIENT_CAPABILITIES,
  CLIENT_INFO,
  isHttpTransport,
  loadUpstreamConfig,
  resolveUpstream,
  type ResolvedUpstream,
  type StoredOAuthState,
} from "./config";
import { HealthMonitor } from "./health";
import { HttpUpstream, errorMessage } from "./http";
import { DbOAuthStore, OAuthManager } from "./oauth";
import { StderrRing, StdioUpstream } from "./stdio";
import type {
  CallOptions,
  CallToolOutcome,
  PromptListItem,
  ResourceListItem,
  ResourceTemplateListItem,
  TestConfigInput,
  ToolListItem,
  UpstreamListing,
  UpstreamManager,
  UpstreamState,
} from "./types";
import { setUpstreamManager } from "./types";

const { upstreamItems, upstreams, toolDiscoveries, toolSearch } = schema;

/** Max upstreams connected in parallel at boot (spec §4.3). */
export const START_ALL_CONCURRENCY = 5;

/** Delay applied when an upstream announces a list_changed, to coalesce bursts. */
const LIST_CHANGED_DEBOUNCE_MS = 250;

/** Upper bound for paginated listings, to avoid an upstream looping forever. */
const MAX_LIST_PAGES = 50;

export interface ManagerOptions {
  /** Starts the ping/backoff loops (disable in tests). */
  autoHealth?: boolean;
  /** Overrides for tests. */
  clientInfo?: Implementation;
  clientCapabilities?: ClientCapabilities;
}

type ListKind = "tool" | "prompt" | "resource" | "resource_template";

interface Runtime {
  config: ResolvedUpstream;
  status: UpstreamStatus;
  lastError: string | null;
  serverInfo: { name?: string; version?: string } | null;
  capabilities: Record<string, unknown> | null;
  stderr: StderrRing;
  toolCount: number;
  http?: HttpUpstream;
  stdio?: StdioUpstream;
  oauth?: OAuthManager;
  health?: HealthMonitor;
  listing: UpstreamListing | null;
  refreshPromise: Promise<void> | null;
  closed: boolean;
}

/**
 * The UpstreamManager (spec §2.1, §4). Owns one SDK Client per enabled upstream,
 * caches listings into `upstream_items`/`tool_search`, records new tools in
 * `tool_discoveries`, keeps the `upstreams` status columns current and emits UI events.
 */
export class Manager implements UpstreamManager {
  private runtimes = new Map<string, Runtime>();
  private options: ManagerOptions;
  private shuttingDown = false;
  private listChangedTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: ManagerOptions = {}) {
    this.options = options;
  }

  // ---- lifecycle ---------------------------------------------------------

  /** Connects every enabled upstream whose startMode is "always" (concurrency 5). */
  async startAll(): Promise<void> {
    const configs = this.loadAllConfigs();
    for (const config of configs) this.ensureRuntime(config);
    const always = configs.filter((config) => config.enabled && config.startMode === "always");
    const lazyToPrime = configs.filter(
      (config) =>
        config.enabled && config.startMode === "lazy" && config.transport === "stdio" && hasNoCachedListing(config.id),
    );
    await runWithConcurrency(
      [
        ...always.map((config) => () => this.connectRuntime(config.id)),
        ...lazyToPrime.map((config) => () => this.primeLazyUpstream(config.id)),
      ],
      START_ALL_CONCURRENCY,
    );
  }

  /**
   * Lazy stdio: start once to capture the listing (spec §4.3 — "listing mis en cache, pris au
   * premier démarrage"), then stop the child again. Calls restart it on demand.
   */
  private async primeLazyUpstream(upstreamId: string): Promise<void> {
    await this.connectRuntime(upstreamId);
    const runtime = this.runtimes.get(upstreamId);
    if (!runtime) return;
    runtime.health?.stop();
    runtime.health = undefined;
    if (runtime.stdio?.isRunning) await runtime.stdio.stop();
    if (runtime.toolCount > 0) this.setStatus(runtime, "ready", null);
    this.emitStatus(runtime);
  }

  /** Stops timers, closes HTTP clients and terminates stdio children. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.listChangedTimers.values()) clearTimeout(timer);
    this.listChangedTimers.clear();
    await Promise.all([...this.runtimes.keys()].map((id) => this.teardownRuntime(id)));
    this.runtimes.clear();
  }

  /** Ensures a connection exists, starting a lazy stdio child when needed. */
  async ensureConnected(upstreamId: string): Promise<void> {
    const runtime = this.runtime(upstreamId);
    if (!runtime) throw new Error(`unknown upstream: ${upstreamId}`);
    if (!runtime.config.enabled) throw new Error(`upstream ${runtime.config.name} is disabled`);
    if (this.isUsable(runtime)) {
      runtime.health?.noteActivity();
      return;
    }
    await this.connectRuntime(upstreamId);
    if (!this.isUsable(runtime)) {
      throw new Error(runtime.lastError ?? `upstream ${runtime.config.name} is not ready`);
    }
  }

  /** Closes the connection; for stdio, stops the child process. */
  async disconnect(upstreamId: string): Promise<void> {
    const runtime = this.runtimes.get(upstreamId);
    if (!runtime) return;
    runtime.health?.stop();
    runtime.health = undefined;
    if (runtime.http) {
      await runtime.http.close();
      runtime.http = undefined;
    }
    if (runtime.stdio) await runtime.stdio.stop();
    this.setStatus(runtime, runtime.config.startMode === "lazy" ? "ready" : "degraded", null);
    this.emitStatus(runtime);
  }

  /** Full reconnect after a config change. */
  async restart(upstreamId: string): Promise<void> {
    const config = loadUpstreamConfig(upstreamId);
    if (!config) {
      await this.remove(upstreamId);
      return;
    }
    await this.teardownRuntime(upstreamId);
    const runtime = this.ensureRuntime(config);
    runtime.status = config.enabled ? "connecting" : "disabled";
    runtime.lastError = config.enabled ? null : runtime.lastError;
    this.emitStatus(runtime);
    if (config.enabled && config.startMode === "always") {
      await this.connectRuntime(upstreamId);
    } else if (config.enabled && hasNoCachedListing(config.id)) {
      await this.primeLazyUpstream(upstreamId);
    }
  }

  /** Reloads config from DB and reconciles (used by the API after CRUD). */
  async reload(upstreamId: string): Promise<void> {
    await this.restart(upstreamId);
  }

  /** Forgets an upstream entirely (row deleted). */
  async remove(upstreamId: string): Promise<void> {
    const runtime = this.runtimes.get(upstreamId);
    await this.teardownRuntime(upstreamId);
    this.runtimes.delete(upstreamId);
    emitUiEvent("upstream.status", { upstreamId, status: "disabled", error: null, removed: true });
    if (runtime) invalidateCatalog("upstream.removed");
  }

  // ---- state -------------------------------------------------------------

  getState(upstreamId: string): UpstreamState | null {
    const runtime = this.runtimes.get(upstreamId);
    return runtime ? this.toState(runtime) : null;
  }

  getAllStates(): UpstreamState[] {
    return [...this.runtimes.values()].map((runtime) => this.toState(runtime));
  }

  getStderr(upstreamId: string): string[] {
    return this.runtimes.get(upstreamId)?.stderr.toArray() ?? [];
  }

  // ---- listings & calls --------------------------------------------------

  async listTools(upstreamId: string): Promise<ToolListItem[]> {
    const runtime = await this.connected(upstreamId);
    const client = this.client(runtime);
    return (await paginate((cursor) => client.listTools(cursor ? { cursor } : undefined), "tools")).map(toToolListItem);
  }

  async callTool(
    upstreamId: string,
    toolName: string,
    args: Record<string, unknown>,
    options: CallOptions = {},
  ): Promise<CallToolOutcome> {
    const runtime = await this.connected(upstreamId);
    const client = this.client(runtime);
    runtime.health?.noteActivity();
    const timeoutMs = options.timeoutMs ?? timeoutFor(runtime.config);
    try {
      const result = await client.callTool({ name: toolName, arguments: args }, undefined, {
        signal: options.signal,
        timeout: timeoutMs,
        onprogress: options.onProgress
          ? (progress) =>
              options.onProgress?.({
                progress: progress.progress,
                total: progress.total,
                message: progress.message,
              })
          : undefined,
      });
      return normalizeCallResult(result);
    } catch (error) {
      if (isTransportFailure(error)) this.handleConnectionLoss(runtime, errorMessage(error));
      throw error;
    }
  }

  async ping(upstreamId: string): Promise<boolean> {
    const runtime = this.runtimes.get(upstreamId);
    if (!runtime) return false;
    const client = this.safeClient(runtime);
    if (!client) return false;
    try {
      await client.ping({ timeout: 10_000 });
      runtime.health?.markHealthy();
      if (runtime.status !== "ready") this.setStatus(runtime, "ready", null);
      return true;
    } catch {
      return false;
    }
  }

  async listPrompts(upstreamId: string): Promise<PromptListItem[]> {
    const runtime = await this.connected(upstreamId);
    const client = this.client(runtime);
    return (await paginate((cursor) => client.listPrompts(cursor ? { cursor } : undefined), "prompts")).map(toPromptListItem);
  }

  async getPrompt(upstreamId: string, name: string, args: Record<string, string> = {}): Promise<unknown> {
    const runtime = await this.connected(upstreamId);
    runtime.health?.noteActivity();
    return this.client(runtime).getPrompt({ name, arguments: args }, { timeout: timeoutFor(runtime.config) });
  }

  async listResources(upstreamId: string): Promise<ResourceListItem[]> {
    const runtime = await this.connected(upstreamId);
    const client = this.client(runtime);
    return (await paginate((cursor) => client.listResources(cursor ? { cursor } : undefined), "resources")).map(
      toResourceListItem,
    );
  }

  async listResourceTemplates(upstreamId: string): Promise<ResourceTemplateListItem[]> {
    const runtime = await this.connected(upstreamId);
    const client = this.client(runtime);
    return (
      await paginate(
        (cursor) => client.listResourceTemplates(cursor ? { cursor } : undefined),
        "resourceTemplates",
      )
    ).map(toResourceTemplateListItem);
  }

  async readResource(upstreamId: string, uri: string): Promise<unknown> {
    const runtime = await this.connected(upstreamId);
    runtime.health?.noteActivity();
    return this.client(runtime).readResource({ uri }, { timeout: timeoutFor(runtime.config) });
  }

  async subscribeResource(upstreamId: string, uri: string): Promise<void> {
    const runtime = await this.connected(upstreamId);
    await this.client(runtime).subscribeResource({ uri });
  }

  async unsubscribeResource(upstreamId: string, uri: string): Promise<void> {
    const runtime = await this.connected(upstreamId);
    await this.client(runtime).unsubscribeResource({ uri });
  }

  // ---- OAuth -------------------------------------------------------------

  async startOAuth(upstreamId: string): Promise<{ authorizationUrl: string }> {
    const runtime = this.runtime(upstreamId);
    if (!runtime) throw new Error(`unknown upstream: ${upstreamId}`);
    if (!isHttpTransport(runtime.config.transport)) {
      throw new Error("OAuth est réservé aux upstreams HTTP ou SSE");
    }
    if (!runtime.config.url) throw new Error("Cet upstream n'a pas d'URL configurée");
    const oauth = this.oauthManagerFor(runtime);
    try {
      return await oauth.startOAuth();
    } catch (error) {
      this.setStatus(runtime, "auth_required", errorMessage(error));
      this.emitStatus(runtime);
      throw error;
    }
  }

  async completeOAuth(upstreamId: string, params: Record<string, string>): Promise<void> {
    const runtime = this.runtime(upstreamId);
    if (!runtime) throw new Error(`unknown upstream: ${upstreamId}`);
    const oauth = this.oauthManagerFor(runtime);
    try {
      await oauth.completeOAuth(params);
    } catch (error) {
      this.setStatus(runtime, "auth_required", errorMessage(error));
      this.emitStatus(runtime);
      throw error;
    }
    // Credentials are usable now: reconnect so the listing reflects the new access.
    await this.restart(upstreamId);
  }

  // ---- config test -------------------------------------------------------

  /** Opens a throwaway connection, runs initialize + tools/list, and always cleans up. */
  async testConfig(candidate: TestConfigInput): Promise<{
    ok: boolean;
    serverInfo?: { name?: string; version?: string };
    capabilities?: Record<string, unknown>;
    tools?: ToolListItem[];
    error?: string;
  }> {
    const clientInfo = this.options.clientInfo ?? CLIENT_INFO;
    const capabilities = this.options.clientCapabilities ?? CLIENT_CAPABILITIES;
    let client: Client | null = null;
    let http: HttpUpstream | null = null;
    let stdio: StdioUpstream | null = null;
    try {
      if (candidate.transport === "stdio") {
        if (!candidate.command) return { ok: false, error: "La commande est obligatoire pour un upstream stdio." };
        stdio = new StdioUpstream({
          command: candidate.command,
          args: candidate.args ?? [],
          cwd: candidate.cwd ?? null,
          env: candidate.env ?? null,
          clientInfo,
          capabilities,
        });
        client = await stdio.start();
      } else {
        if (!candidate.url) return { ok: false, error: "L'URL est obligatoire pour un upstream HTTP." };
        if (candidate.authType === "oauth") {
          return {
            ok: false,
            error: "Un upstream OAuth se vérifie après la connexion, depuis sa fiche.",
          };
        }
        http = new HttpUpstream({
          url: candidate.url,
          transport: candidate.transport,
          headers: candidate.headers ?? null,
          authType: candidate.authType,
          clientInfo,
          capabilities,
        });
        client = (await http.connect()).client;
      }
      const serverVersion = client.getServerVersion();
      const serverCapabilities = client.getServerCapabilities() as Record<string, unknown> | undefined;
      const tools = (await paginate((cursor) => client!.listTools(cursor ? { cursor } : undefined), "tools")).map(
        toToolListItem,
      );
      return {
        ok: true,
        serverInfo: serverVersion ? { name: serverVersion.name, version: serverVersion.version } : undefined,
        capabilities: serverCapabilities ?? undefined,
        tools,
      };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      if (http) {
        try {
          await http.close();
        } catch {
          /* ignore */
        }
      }
      if (stdio) {
        try {
          await stdio.stop();
        } catch {
          /* ignore */
        }
      } else if (client && !http) {
        try {
          await client.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ---- internals: runtime bookkeeping ------------------------------------

  private loadAllConfigs(): ResolvedUpstream[] {
    return getDb()
      .select()
      .from(upstreams)
      .all()
      .map((row) => resolveUpstream(row));
  }

  private ensureRuntime(config: ResolvedUpstream): Runtime {
    const existing = this.runtimes.get(config.id);
    if (existing) {
      existing.config = config;
      if (!config.enabled && existing.status !== "disabled") {
        this.setStatus(existing, "disabled", null);
        void this.teardownRuntime(config.id);
      }
      return existing;
    }
    const toolCount = this.countTools(config.id);
    const runtime: Runtime = {
      config,
      status: initialStatus(config, toolCount),
      lastError: config.dbLastError,
      serverInfo: null,
      capabilities: null,
      stderr: new StderrRing(),
      toolCount,
      listing: null,
      refreshPromise: null,
      closed: false,
    };
    this.runtimes.set(config.id, runtime);
    // A disabled row must read as such even if the manager never tries to connect it.
    if (runtime.status !== config.dbStatus) {
      this.persistStatus(runtime);
      this.emitStatus(runtime);
    }
    return runtime;
  }

  private runtime(upstreamId: string): Runtime | null {
    const existing = this.runtimes.get(upstreamId);
    if (existing) return existing;
    const config = loadUpstreamConfig(upstreamId);
    return config ? this.ensureRuntime(config) : null;
  }

  private countTools(upstreamId: string): number {
    try {
      return getDb()
        .select({ name: upstreamItems.name })
        .from(upstreamItems)
        .where(and(eq(upstreamItems.upstreamId, upstreamId), eq(upstreamItems.kind, "tool")))
        .all().length;
    } catch {
      return 0;
    }
  }

  private toState(runtime: Runtime): UpstreamState {
    return {
      id: runtime.config.id,
      slug: runtime.config.slug,
      status: runtime.status,
      lastError: runtime.lastError,
      serverInfo: runtime.serverInfo,
      capabilities: runtime.capabilities,
      stderr: runtime.stderr.toArray(),
      toolCount: runtime.toolCount,
    };
  }

  private setStatus(runtime: Runtime, status: UpstreamStatus, error: string | null): void {
    const redacted = error === null ? null : getRedactor().redact(error);
    const changed = runtime.status !== status || runtime.lastError !== redacted;
    runtime.status = status;
    runtime.lastError = redacted;
    if (!changed) return;
    this.persistStatus(runtime);
    this.emitStatus(runtime);
  }

  private emitStatus(runtime: Runtime): void {
    emitUiEvent("upstream.status", {
      upstreamId: runtime.config.id,
      slug: runtime.config.slug,
      status: runtime.status,
      error: runtime.lastError,
      serverInfo: runtime.serverInfo,
      capabilities: runtime.capabilities,
      toolCount: runtime.toolCount,
    });
  }

  private persistStatus(runtime: Runtime): void {
    try {
      const now = Date.now();
      getDb()
        .update(upstreams)
        .set({
          status: runtime.status,
          lastError: runtime.lastError,
          lastReadyAt: runtime.status === "ready" ? now : undefined,
          capabilities: runtime.capabilities as never,
          serverInfo: runtime.serverInfo as never,
          updatedAt: now,
        })
        .where(eq(upstreams.id, runtime.config.id))
        .run();
    } catch (error) {
      logger.warn({ err: errorMessage(error), upstreamId: runtime.config.id }, "failed to persist upstream status");
    }
  }

  private isUsable(runtime: Runtime): boolean {
    return runtime.http?.isConnected === true || runtime.stdio?.isRunning === true;
  }

  private safeClient(runtime: Runtime): Client | null {
    try {
      if (runtime.http?.isConnected) return runtime.http.sdkClient;
      if (runtime.stdio?.isRunning) return runtime.stdio.sdkClient();
    } catch {
      return null;
    }
    return null;
  }

  private client(runtime: Runtime): Client {
    const client = this.safeClient(runtime);
    if (!client) throw new Error(`upstream ${runtime.config.name} is not connected`);
    return client;
  }

  private async connected(upstreamId: string): Promise<Runtime> {
    const runtime = this.runtime(upstreamId);
    if (!runtime) throw new Error(`unknown upstream: ${upstreamId}`);
    if (!this.isUsable(runtime)) await this.ensureConnected(upstreamId);
    runtime.health?.noteActivity();
    return runtime;
  }

  // ---- internals: connecting --------------------------------------------

  private async connectRuntime(upstreamId: string): Promise<void> {
    const runtime = this.runtimes.get(upstreamId) ?? this.runtime(upstreamId);
    if (!runtime || this.shuttingDown) return;
    const config = runtime.config;
    if (!config.enabled) {
      this.setStatus(runtime, "disabled", null);
      return;
    }
    runtime.closed = false;
    if (runtime.status !== "auth_required") this.setStatus(runtime, "connecting", null);

    try {
      if (config.transport === "stdio") await this.connectStdio(runtime);
      else await this.connectHttp(runtime);
      if (runtime.status === "auth_required") {
        this.emitStatus(runtime);
        return;
      }
      this.setStatus(runtime, "ready", null);
      await this.refreshListing(runtime, { discovered: true });
      this.startHealth(runtime);
      runtime.health?.markHealthy();
    } catch (error) {
      const message = errorMessage(error);
      const authRequired = isAuthRequired(error);
      if (authRequired) this.setStatus(runtime, "auth_required", message);
      else this.setStatus(runtime, runtime.status === "ready" ? "degraded" : "error", message);
      logger.warn({ upstreamId, slug: config.slug, err: message }, "upstream connect failed");
      if (!authRequired) {
        this.startHealth(runtime);
        runtime.health?.reportFailure(message);
      }
    }
  }

  private async connectHttp(runtime: Runtime): Promise<void> {
    const config = runtime.config;
    if (!config.url) throw new Error("Aucune URL configurée pour cet upstream HTTP");
    let authProvider: OAuthManager | undefined;
    if (config.authType === "oauth") {
      const oauth = this.oauthManagerFor(runtime);
      const authorized = await oauth.ensureAuthorized();
      if (!authorized) {
        this.setStatus(runtime, "auth_required", runtime.lastError ?? "Reconnexion OAuth nécessaire");
        return;
      }
      authProvider = oauth;
    }
    const current = runtime.http;
    if (current?.isConnected && current.url === config.url) return;
    if (current) await current.close();

    const http = new HttpUpstream({
      url: config.url,
      transport: config.transport === "sse" ? "sse" : "http",
      headers: config.headers,
      authType: config.authType,
      clientInfo: this.options.clientInfo ?? CLIENT_INFO,
      capabilities: this.options.clientCapabilities ?? CLIENT_CAPABILITIES,
      authProvider,
      onListChanged: (kind) => this.scheduleListRefresh(runtime, kind),
    });
    const connected = await http.connect();
    runtime.http = http;
    runtime.serverInfo = asServerInfo(connected.client.getServerVersion());
    runtime.capabilities = (connected.client.getServerCapabilities() as Record<string, unknown> | undefined) ?? null;
    runtime.closed = false;
    connected.client.onclose = () => this.handleConnectionLoss(runtime, "connexion perdue");
  }

  private async connectStdio(runtime: Runtime): Promise<void> {
    const config = runtime.config;
    if (!config.command) throw new Error("Aucune commande configurée pour cet upstream stdio");
    if (runtime.stdio?.isRunning) return;

    const upstream =
      runtime.stdio ??
      new StdioUpstream({
        command: config.command,
        args: config.args ?? [],
        cwd: config.cwd,
        env: config.env,
        clientInfo: this.options.clientInfo ?? CLIENT_INFO,
        capabilities: this.options.clientCapabilities ?? CLIENT_CAPABILITIES,
        onListChanged: (kind) => this.scheduleListRefresh(runtime, kind),
        ring: runtime.stderr,
      });
    runtime.stdio = upstream;
    const client = await upstream.start();
    runtime.serverInfo = asServerInfo(client.getServerVersion());
    runtime.capabilities = (client.getServerCapabilities() as Record<string, unknown> | undefined) ?? null;
    runtime.closed = false;
    client.onclose = () => this.handleConnectionLoss(runtime, "processus stdio terminé");
  }

  /** Coalesces upstream list_changed bursts into one refresh. */
  private scheduleListRefresh(runtime: Runtime, kind: string): void {
    const id = runtime.config.id;
    const existing = this.listChangedTimers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.listChangedTimers.delete(id);
      void this.refreshListing(runtime, { discovered: true }).catch((error) => {
        logger.warn({ upstreamId: id, err: errorMessage(error) }, "listing refresh after list_changed failed");
      });
    }, LIST_CHANGED_DEBOUNCE_MS);
    if (typeof timer.unref === "function") timer.unref();
    this.listChangedTimers.set(id, timer);
    logger.debug({ upstreamId: id, kind }, "upstream list_changed received");
  }

  private startHealth(runtime: Runtime): void {
    if (this.options.autoHealth === false) return;
    if (runtime.health?.isRunning) return;
    const isStdio = runtime.config.transport === "stdio";
    const idleStopMs = isStdio && runtime.config.startMode === "lazy" ? runtime.config.idleStopMinutes * 60_000 : 0;
    runtime.health = new HealthMonitor({
      hooks: {
        ping: async () => this.pingNow(runtime),
        reconnect: async () => this.reconnectNow(runtime),
        onGaveUp: () => {
          this.setStatus(runtime, "error", runtime.lastError ?? "upstream injoignable");
          this.emitStatus(runtime);
        },
        onIdle: async () => {
          if (runtime.stdio?.isRunning) {
            await runtime.stdio.stop();
            logger.debug({ upstreamId: runtime.config.id }, "lazy stdio upstream stopped after idle");
          }
        },
      },
      pingIntervalMs: isStdio ? 0 : undefined,
      idleStopMs,
    });
    runtime.health.start();
  }

  private async pingNow(runtime: Runtime): Promise<boolean> {
    return this.safeClient(runtime) ? this.ping(runtime.config.id) : false;
  }

  private async reconnectNow(runtime: Runtime): Promise<boolean> {
    if (this.shuttingDown || runtime.closed) return false;
    if (!runtime.config.enabled) return true;
    if (runtime.http) {
      await runtime.http.close();
      runtime.http = undefined;
    }
    if (runtime.stdio) await runtime.stdio.stop();
    const fresh = loadUpstreamConfig(runtime.config.id);
    if (fresh) runtime.config = fresh;
    await this.connectRuntime(runtime.config.id);
    return this.isUsable(runtime);
  }

  private handleConnectionLoss(runtime: Runtime, reason: string): void {
    if (runtime.closed || this.shuttingDown) return;
    if (runtime.status === "ready" || runtime.status === "degraded") {
      this.setStatus(runtime, "degraded", reason);
    }
    runtime.health?.reportFailure(reason);
  }

  private async teardownRuntime(upstreamId: string): Promise<void> {
    const runtime = this.runtimes.get(upstreamId);
    if (!runtime) return;
    runtime.closed = true;
    runtime.health?.stop();
    runtime.health = undefined;
    const pending = this.listChangedTimers.get(upstreamId);
    if (pending) {
      clearTimeout(pending);
      this.listChangedTimers.delete(upstreamId);
    }
    if (runtime.http) {
      await runtime.http.close();
      runtime.http = undefined;
    }
    if (runtime.stdio) await runtime.stdio.stop();
  }

  // ---- internals: listing cache -----------------------------------------

  /**
   * Re-reads the four listings, upserts them into `upstream_items` (+ deletes vanished
   * rows, leaving grant_tools untouched), mirrors tools into `tool_search`, records new
   * tools in `tool_discoveries` and invalidates the catalog.
   */
  private async refreshListing(runtime: Runtime, options: { discovered: boolean }): Promise<void> {
    if (runtime.refreshPromise) return runtime.refreshPromise;
    const task = (async () => {
      const client = this.safeClient(runtime);
      if (!client) throw new Error(`upstream ${runtime.config.name} is not connected`);
      const capabilities = client.getServerCapabilities();
      const tools = (await paginate((cursor) => client.listTools(cursor ? { cursor } : undefined), "tools")).map(
        toToolListItem,
      );
      const prompts = capabilities?.prompts
        ? (await paginate((cursor) => client.listPrompts(cursor ? { cursor } : undefined), "prompts")).map(
            toPromptListItem,
          )
        : [];
      const resources = capabilities?.resources
        ? (await paginate((cursor) => client.listResources(cursor ? { cursor } : undefined), "resources")).map(
            toResourceListItem,
          )
        : [];
      const resourceTemplates = capabilities?.resources
        ? (
            await paginate(
              (cursor) => client.listResourceTemplates(cursor ? { cursor } : undefined),
              "resourceTemplates",
            )
          ).map(toResourceTemplateListItem)
        : [];
      const previousTools = this.previousToolNames(runtime.config.id);
      const listing: UpstreamListing = { tools, prompts, resources, resourceTemplates };
      this.persistListing(runtime.config, listing, Date.now());
      runtime.listing = listing;
      runtime.toolCount = tools.length;
      this.persistStatus(runtime);
      emitUiEvent("upstream.items", {
        upstreamId: runtime.config.id,
        slug: runtime.config.slug,
        tools: tools.length,
        prompts: prompts.length,
        resources: resources.length,
        resourceTemplates: resourceTemplates.length,
      });
      if (options.discovered) this.recordDiscoveries(runtime.config, previousTools, tools);
      invalidateCatalog(`upstream:${runtime.config.slug}`);
    })();
    runtime.refreshPromise = task.finally(() => {
      runtime.refreshPromise = null;
    });
    return runtime.refreshPromise;
  }

  private previousToolNames(upstreamId: string): Set<string> {
    return new Set(
      getDb()
        .select({ name: upstreamItems.name })
        .from(upstreamItems)
        .where(and(eq(upstreamItems.upstreamId, upstreamId), eq(upstreamItems.kind, "tool")))
        .all()
        .map((row) => row.name),
    );
  }

  private persistListing(config: ResolvedUpstream, listing: UpstreamListing, now: number): void {
    interface Row {
      kind: ListKind;
      name: string;
      definition: Record<string, unknown>;
    }
    const rows: Row[] = [
      ...listing.tools.map((tool) => ({
        kind: "tool" as const,
        name: tool.name,
        definition: {
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          annotations: tool.annotations,
        },
      })),
      ...listing.prompts.map((prompt) => ({
        kind: "prompt" as const,
        name: prompt.name,
        definition: { name: prompt.name, description: prompt.description, arguments: prompt.arguments },
      })),
      ...listing.resources.map((resource) => ({
        kind: "resource" as const,
        name: resource.uri,
        definition: {
          name: resource.name,
          uri: resource.uri,
          description: resource.description,
          mimeType: resource.mimeType,
        },
      })),
      ...listing.resourceTemplates.map((template) => ({
        kind: "resource_template" as const,
        name: template.uriTemplate,
        definition: {
          name: template.name,
          uriTemplate: template.uriTemplate,
          description: template.description,
          mimeType: template.mimeType,
        },
      })),
    ];

    const db = getDb();
    const id = config.id;
    db.transaction(() => {
      const byKind = new Map<ListKind, string[]>();
      for (const row of rows) {
        const list = byKind.get(row.kind) ?? [];
        list.push(row.name);
        byKind.set(row.kind, list);
      }
      const kinds: ListKind[] = ["tool", "prompt", "resource", "resource_template"];
      for (const kind of kinds) {
        const names = byKind.get(kind) ?? [];
        const scope = and(eq(upstreamItems.upstreamId, id), eq(upstreamItems.kind, kind));
        if (names.length === 0) db.delete(upstreamItems).where(scope).run();
        else db.delete(upstreamItems).where(and(scope, notInArray(upstreamItems.name, names))).run();
      }
      for (const row of rows) {
        db.insert(upstreamItems)
          .values({
            upstreamId: id,
            kind: row.kind,
            name: row.name,
            definition: row.definition as never,
            fetchedAt: now,
          })
          .onConflictDoUpdate({
            target: [upstreamItems.upstreamId, upstreamItems.kind, upstreamItems.name],
            set: { definition: row.definition as never, fetchedAt: now },
          })
          .run();
      }
      // Mirror for discovery mode; the gateway rebuilds public names when it reindexes.
      db.delete(toolSearch).where(eq(toolSearch.upstreamId, id)).run();
      for (const tool of listing.tools) {
        db.insert(toolSearch)
          .values({
            upstreamId: id,
            toolName: tool.name,
            // Mirrors the catalog's naming rules (aliases/overrides are applied there).
            publicName: buildPublicName(config.slug, tool.name).publicName,
            description: tool.description ?? null,
          })
          .run();
      }
    });
  }

  /** Records tools seen for the first time and emits a discovery event per tool. */
  private recordDiscoveries(config: ResolvedUpstream, previous: Set<string>, tools: ToolListItem[]): void {
    const fresh = tools.filter((tool) => !previous.has(tool.name));
    if (fresh.length === 0) return;
    const db = getDb();
    const now = Date.now();
    for (const tool of fresh) {
      db.insert(toolDiscoveries)
        .values({ upstreamId: config.id, toolName: tool.name, firstSeenAt: now, acknowledgedAt: null })
        .onConflictDoNothing()
        .run();
      emitUiEvent("discovery.new", {
        upstreamId: config.id,
        upstreamSlug: config.slug,
        toolName: tool.name,
        description: tool.description ?? null,
      });
    }
    logger.info({ upstreamId: config.id, slug: config.slug, count: fresh.length }, "new upstream tools discovered");
  }

  // ---- internals: oauth --------------------------------------------------

  private oauthManagerFor(runtime: Runtime): OAuthManager {
    if (runtime.oauth) return runtime.oauth;
    const oauth = new OAuthManager({
      store: new DbOAuthStore(runtime.config.id),
      clientName: `Switchboard (${runtime.config.name})`,
      onAuthRequired: (upstreamId, error) => {
        const target = this.runtimes.get(upstreamId);
        if (!target) return;
        this.setStatus(target, "auth_required", error);
      },
    });
    runtime.oauth = oauth;
    return oauth;
  }
}

// ---- module-level helpers ------------------------------------------------

/** Creates the process-wide manager and registers it with setUpstreamManager(). */
export function createUpstreamManager(options: ManagerOptions = {}): Manager {
  const manager = new Manager(options);
  instance = manager;
  setUpstreamManager(manager);
  return manager;
}

let instance: Manager | null = null;

/** Returns the registered manager, creating one on first use. */
export function getManager(): Manager {
  if (!instance) return createUpstreamManager();
  return instance;
}

/** Test helper: drops the cached module-level instance. */
export function resetManagerForTests(): void {
  instance = null;
}

async function runWithConcurrency(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let index = 0;
  const workerCount = Math.min(limit, tasks.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const current = index++;
      if (current >= tasks.length) return;
      const task = tasks[current];
      if (!task) continue;
      try {
        await task();
      } catch (error) {
        logger.warn({ err: errorMessage(error) }, "upstream task failed");
      }
    }
  });
  await Promise.all(workers);
}

/** Follows nextCursor until the upstream stops paginating. */
async function paginate(
  fetchPage: (cursor: string | undefined) => Promise<{ [key: string]: unknown }>,
  key: string,
): Promise<unknown[]> {
  const out: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const result = await fetchPage(cursor);
    const items = result[key];
    if (Array.isArray(items)) out.push(...(items as unknown[]));
    const next = result["nextCursor"];
    if (typeof next !== "string" || next.length === 0) return out;
    cursor = next;
  }
  return out;
}

/** A lazy stdio upstream whose listing was never fetched needs one priming connection. */
function hasNoCachedListing(upstreamId: string): boolean {
  try {
    return (
      getDb()
        .select({ name: upstreamItems.name })
        .from(upstreamItems)
        .where(eq(upstreamItems.upstreamId, upstreamId))
        .all().length === 0
    );
  } catch {
    return false;
  }
}

/**
 * Status at load time. Lazy stdio upstreams report `ready` as soon as their listing is
 * cached: the catalog only exposes tools of `ready` upstreams, and spec §4.3 requires
 * those tools to stay visible while the child process is stopped.
 */
function initialStatus(config: ResolvedUpstream, cachedToolCount: number): UpstreamStatus {
  if (!config.enabled) return "disabled";
  if (config.dbStatus === "disabled") return config.startMode === "lazy" && cachedToolCount > 0 ? "ready" : "connecting";
  if (config.startMode === "lazy" && config.transport === "stdio" && cachedToolCount > 0 && config.dbStatus === "connecting") {
    return "ready";
  }
  return config.dbStatus;
}

/** Per-call timeout: rows with 0 disable the explicit timeout. */
function timeoutFor(config: ResolvedUpstream): number | undefined {
  return config.callTimeoutSeconds > 0 ? config.callTimeoutSeconds * 1000 : undefined;
}

function asServerInfo(value: Implementation | undefined): { name?: string; version?: string } | null {
  if (!value) return null;
  return { name: value.name, version: value.version };
}

interface RawTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

function toToolListItem(raw: unknown): ToolListItem {
  const input = (raw ?? {}) as RawTool;
  const name = typeof input.name === "string" ? input.name : "";
  const description = typeof input.description === "string" ? input.description : undefined;
  return {
    name,
    description,
    inputSchema: input.inputSchema ?? { type: "object", properties: {} },
    outputSchema: input.outputSchema,
    annotations: input.annotations,
  };
}

interface RawNamed {
  name?: unknown;
  description?: unknown;
  arguments?: unknown;
}

function toPromptListItem(raw: unknown): PromptListItem {
  const input = (raw ?? {}) as RawNamed;
  return {
    name: typeof input.name === "string" ? input.name : "",
    description: typeof input.description === "string" ? input.description : undefined,
    arguments: input.arguments,
  };
}

interface RawResource {
  uri?: unknown;
  name?: unknown;
  description?: unknown;
  mimeType?: unknown;
}

function toResourceListItem(raw: unknown): ResourceListItem {
  const input = (raw ?? {}) as RawResource;
  const uri = typeof input.uri === "string" ? input.uri : "";
  return {
    uri,
    name: typeof input.name === "string" ? input.name : uri,
    description: typeof input.description === "string" ? input.description : undefined,
    mimeType: typeof input.mimeType === "string" ? input.mimeType : undefined,
  };
}

interface RawResourceTemplate {
  uriTemplate?: unknown;
  name?: unknown;
  description?: unknown;
  mimeType?: unknown;
}

function toResourceTemplateListItem(raw: unknown): ResourceTemplateListItem {
  const input = (raw ?? {}) as RawResourceTemplate;
  const uriTemplate = typeof input.uriTemplate === "string" ? input.uriTemplate : "";
  return {
    uriTemplate,
    name: typeof input.name === "string" ? input.name : uriTemplate,
    description: typeof input.description === "string" ? input.description : undefined,
    mimeType: typeof input.mimeType === "string" ? input.mimeType : undefined,
  };
}

/** Some SDK versions return a compatibility `{ toolResult }` shape; normalise both. */
function normalizeCallResult(result: unknown): CallToolOutcome {
  if (result && typeof result === "object" && "toolResult" in result && !("content" in result)) {
    return { content: [(result as { toolResult: unknown }).toolResult], isError: false };
  }
  const value = result as { content?: unknown[]; isError?: boolean; structuredContent?: unknown };
  return {
    content: Array.isArray(value.content) ? value.content : [],
    isError: value.isError === true,
    structuredContent: value.structuredContent,
  };
}

/** Heuristic: did this error mean the transport is gone? */
export function isTransportFailure(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("not connected") ||
    message.includes("connection closed") ||
    message.includes("connection lost") ||
    message.includes("transport") ||
    message.includes("fetch failed") ||
    message.includes("econnrefused") ||
    message.includes("econnreset") ||
    message.includes("epipe") ||
    message.includes("socket hang up")
  );
}

/** Heuristic: does this error mean the upstream needs an OAuth reconnect? */
export function isAuthRequired(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = errorMessage(error).toLowerCase();
  return (
    name === "UnauthorizedError" ||
    message.includes("401") ||
    message.includes("unauthorized") ||
    message.includes("authorization required")
  );
}

export type { ResolvedUpstream, StoredOAuthState } from "./config";
