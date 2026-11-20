import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { ClientCapabilities, Implementation, ListChangedHandlers } from "@modelcontextprotocol/sdk/types.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AuthType } from "../types";
import { errorMessage } from "./stdio";

export { errorMessage };

/**
 * HTTP upstream: Streamable HTTP by default, with automatic fallback to the legacy SSE
 * transport when `initialize` fails with a 4xx (notably 405) — spec §4.1.
 */

/** How long a connect attempt may take before it is abandoned. */
export const CONNECT_TIMEOUT_MS = 30_000;

/** Headers that must never be overridden by user-supplied custom headers. */
const PROTECTED_HEADERS = new Set(["mcp-session-id", "mcp-protocol-version"]);

export interface HttpUpstreamOptions {
  url: string;
  /** Configured transport. "http" auto-falls back to SSE; "sse" goes straight to SSE. */
  transport: "http" | "sse";
  headers?: Record<string, string> | null;
  authType: AuthType;
  clientInfo: Implementation;
  capabilities?: ClientCapabilities;
  /** OAuth provider, required when authType === "oauth". */
  authProvider?: OAuthClientProvider;
  fetchImpl?: FetchLike;
  /** Overrides CONNECT_TIMEOUT_MS (tests). */
  connectTimeoutMs?: number;
  /** Receives the upstream's notifications/<kind>/list_changed. */
  onListChanged?: (kind: "tools" | "prompts" | "resources") => void;
}

/** Merges custom headers, dropping anything that would corrupt the transport. */
export function buildHttpHeaders(headers: Record<string, string> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (PROTECTED_HEADERS.has(key.toLowerCase())) continue;
    if (value === null || value === undefined) continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * Builds a fetch implementation that always injects the configured headers. Used for the
 * SSE transport's event stream, where `eventSourceInit` has no headers field.
 */
export function headerFetch(baseFetch: FetchLike, headers: Record<string, string>): FetchLike {
  return async (url, init) => {
    const merged = new Headers(init?.headers as HeadersInit | undefined);
    for (const [key, value] of Object.entries(headers)) {
      if (!merged.has(key)) merged.set(key, value);
    }
    return baseFetch(url, { ...init, headers: merged });
  };
}

/** True when an initialize failure suggests the server only speaks the legacy SSE transport. */
export function isSseFallbackError(error: unknown): boolean {
  const code = httpErrorCode(error);
  if (code !== undefined) return code === 405 || (code >= 400 && code < 500);
  // Some servers answer without a parseable status: fall back on the textual hint.
  const message = errorMessage(error).toLowerCase();
  return message.includes("405") || message.includes("method not allowed") || message.includes("text/event-stream");
}

function httpErrorCode(error: unknown): number | undefined {
  if (error instanceof StreamableHTTPError) return error.code;
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number") return code;
  }
  return undefined;
}

export interface HttpConnectResult {
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
  /** The transport actually used (after any fallback). */
  kind: "http" | "sse";
}

export class HttpUpstream {
  readonly url: string;
  readonly configuredTransport: "http" | "sse";
  readonly headers: Record<string, string>;
  private options: HttpUpstreamOptions;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | SSEClientTransport | null = null;
  private usedKind: "http" | "sse" | null = null;

  constructor(options: HttpUpstreamOptions) {
    this.options = options;
    this.url = options.url;
    this.configuredTransport = options.transport;
    this.headers = buildHttpHeaders(options.headers);
  }

  get isConnected(): boolean {
    return this.client !== null;
  }

  get kind(): "http" | "sse" | null {
    return this.usedKind;
  }

  /** Connects, falling back to SSE when the streamable transport is rejected. */
  async connect(): Promise<HttpConnectResult> {
    if (this.client && this.transport && this.usedKind) {
      return { client: this.client, transport: this.transport, kind: this.usedKind };
    }

    const attempts: Array<"http" | "sse"> =
      this.configuredTransport === "sse" ? ["sse"] : ["http", "sse"];
    let lastError: unknown;
    for (const kind of attempts) {
      const transport = this.createTransport(kind);
      const client = new Client(this.options.clientInfo, {
        capabilities: this.options.capabilities,
        listChanged: this.listChangedHandlers(),
      });
      try {
        await client.connect(transport, { timeout: this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS });
      } catch (error) {
        lastError = error;
        await closeQuietly(client);
        // Only fall back when the streamable attempt failed in a way SSE can fix.
        const canFallback = this.configuredTransport === "http" && kind === "http" && isSseFallbackError(error);
        if (!canFallback) throw error;
        continue;
      }
      this.client = client;
      this.transport = transport;
      this.usedKind = kind;
      return { client, transport, kind };
    }
    throw new Error(`cannot connect to ${this.url}: ${errorMessage(lastError)}`);
  }

  /** Wires list_changed notifications to the caller, without auto-refreshing here. */
  private listChangedHandlers(): ListChangedHandlers | undefined {
    const notify = this.options.onListChanged;
    if (!notify) return undefined;
    return {
      tools: { autoRefresh: false, debounceMs: 0, onChanged: () => notify("tools") },
      prompts: { autoRefresh: false, debounceMs: 0, onChanged: () => notify("prompts") },
      resources: { autoRefresh: false, debounceMs: 0, onChanged: () => notify("resources") },
    };
  }

  private createTransport(kind: "http" | "sse"): StreamableHTTPClientTransport | SSEClientTransport {
    const url = new URL(this.url);
    const baseFetch = this.options.fetchImpl;
    const requestInit: RequestInit = { headers: { ...this.headers } };
    if (kind === "http") {
      return new StreamableHTTPClientTransport(url, {
        requestInit,
        authProvider: this.options.authProvider,
        fetch: baseFetch,
      });
    }
    return new SSEClientTransport(url, {
      requestInit,
      // The event stream request gets its headers from a wrapped fetch.
      eventSourceInit: baseFetch || Object.keys(this.headers).length > 0
        ? { fetch: headerFetch(baseFetch ?? ((input, init) => fetch(input as string, init)), this.headers) }
        : undefined,
      authProvider: this.options.authProvider,
      fetch: baseFetch,
    });
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.transport = null;
    if (client) await closeQuietly(client);
    this.usedKind = this.usedKind; // keep for diagnostics
  }

  /** The live SDK client (throws when not connected). */
  get sdkClient(): Client {
    if (!this.client) throw new Error(`upstream ${this.url} is not connected`);
    return this.client;
  }
}

async function closeQuietly(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    /* already closed */
  }
}
