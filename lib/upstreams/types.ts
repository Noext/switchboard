import {
  clearGlobalSingleton,
  peekGlobalSingleton,
  setGlobalSingleton,
} from "../runtime/global";
import type { UpstreamStatus } from "../types";

/** Runtime handle exposed by the upstream manager for one configured upstream. */
export interface UpstreamState {
  id: string;
  slug: string;
  status: UpstreamStatus;
  lastError: string | null;
  serverInfo: { name?: string; version?: string } | null;
  capabilities: Record<string, unknown> | null;
  /** stderr ring buffer (stdio only), last 500 lines. */
  stderr: string[];
  /** number of tools currently cached for this upstream. */
  toolCount: number;
}

export interface ToolListItem {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}

export interface PromptListItem {
  name: string;
  description?: string;
  arguments?: unknown;
}

export interface ResourceListItem {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceTemplateListItem {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface CallToolOutcome {
  content: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface UpstreamListing {
  tools: ToolListItem[];
  prompts: PromptListItem[];
  resources: ResourceListItem[];
  resourceTemplates: ResourceTemplateListItem[];
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onProgress?: (progress: { progress: number; total?: number; message?: string }) => void;
}

/**
 * The contract implemented by lib/upstreams/manager.ts. Everything that talks to an
 * upstream (gateway, API, UI test console) goes through this interface.
 */
export interface UpstreamManager {
  /** Connects all enabled upstreams at boot (max 5 in parallel). */
  startAll(): Promise<void>;
  shutdown(): Promise<void>;

  /** Ensures a connection exists (starts a lazy stdio process if needed). */
  ensureConnected(upstreamId: string): Promise<void>;
  /** Closes the connection; for stdio lazy, stops the process. */
  disconnect(upstreamId: string): Promise<void>;
  /** Full reconnect after a config change. */
  restart(upstreamId: string): Promise<void>;
  /** Reloads config from DB and reconciles (used by the API after CRUD). */
  reload(upstreamId: string): Promise<void>;
  remove(upstreamId: string): Promise<void>;

  getState(upstreamId: string): UpstreamState | null;
  getAllStates(): UpstreamState[];
  getStderr(upstreamId: string): string[];

  listTools(upstreamId: string): Promise<ToolListItem[]>;
  callTool(
    upstreamId: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: CallOptions,
  ): Promise<CallToolOutcome>;
  ping(upstreamId: string): Promise<boolean>;

  listPrompts(upstreamId: string): Promise<PromptListItem[]>;
  getPrompt(upstreamId: string, name: string, args?: Record<string, string>): Promise<unknown>;

  listResources(upstreamId: string): Promise<ResourceListItem[]>;
  listResourceTemplates(upstreamId: string): Promise<ResourceTemplateListItem[]>;
  readResource(upstreamId: string, uri: string): Promise<unknown>;
  subscribeResource(upstreamId: string, uri: string): Promise<void>;
  unsubscribeResource(upstreamId: string, uri: string): Promise<void>;

  /** Starts the OAuth browser flow. Returns the URL the admin must visit. */
  startOAuth(upstreamId: string): Promise<{ authorizationUrl: string }>;
  /** Completes the OAuth flow from the callback query params. */
  completeOAuth(upstreamId: string, params: Record<string, string>): Promise<void>;

  /** Test a candidate config without persisting it (the "Tester la connexion" button). */
  testConfig(candidate: TestConfigInput): Promise<{
    ok: boolean;
    serverInfo?: { name?: string; version?: string };
    capabilities?: Record<string, unknown>;
    tools?: ToolListItem[];
    error?: string;
  }>;
}

export interface TestConfigInput {
  transport: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  authType: "none" | "headers" | "bearer" | "oauth";
}

/** Emitted whenever an upstream's status or listing changes. */
export interface UpstreamManagerEvents {
  statusChanged: { upstreamId: string; status: UpstreamStatus; error: string | null };
  listingChanged: { upstreamId: string };
}

// ---------------------------------------------------------------------------------------------
// Process-wide manager registry
//
// The manager is constructed inside `dist/server.js` but consumed from Next route handlers,
// which are a *different module graph*. A module-level variable would be null there, so the
// instance lives on globalThis (see lib/runtime/global.ts).
// ---------------------------------------------------------------------------------------------

const MANAGER_KEY = "upstream-manager";

export function setUpstreamManager(m: UpstreamManager): void {
  setGlobalSingleton(MANAGER_KEY, m);
}

export function getUpstreamManager(): UpstreamManager {
  const manager = peekGlobalSingleton<UpstreamManager>(MANAGER_KEY);
  if (!manager) throw new Error("UpstreamManager not initialised");
  return manager;
}

export function hasUpstreamManager(): boolean {
  return peekGlobalSingleton<UpstreamManager>(MANAGER_KEY) !== undefined;
}

/** Test helper. */
export function clearUpstreamManager(): void {
  clearGlobalSingleton(MANAGER_KEY);
}
