import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ClientCapabilities, Implementation, ListChangedHandlers } from "@modelcontextprotocol/sdk/types.js";

/**
 * Stdio upstream: spawns a child process and speaks MCP over its stdio.
 *
 * Security (spec §10): the child inherits ONLY its declared env plus `PATH` and `HOME`.
 * The gateway's own environment (SWITCHBOARD_MASTER_KEY, SWITCHBOARD_ADMIN_PASSWORD, …)
 * must never leak into an upstream process.
 */

/** Size of the stderr ring buffer kept per upstream and shown in the UI. */
export const STDERR_RING_SIZE = 500;

/** Environment variables the child is allowed to inherit from the gateway process. */
export const ALLOWED_INHERITED_ENV = ["PATH", "HOME"] as const;

/**
 * Keys the MCP SDK's StdioClientTransport merges in on its own (getDefaultEnvironment()).
 * They are explicitly blanked so a child never sees the gateway's values (SHELL/TERM/USER…).
 */
const SDK_DEFAULT_ENV_KEYS = [
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "USER",
  "APPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PROCESSOR_ARCHITECTURE",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERNAME",
  "USERPROFILE",
  "PROGRAMFILES",
] as const;

export type EnvMap = Record<string, string>;

/**
 * Builds the exact environment handed to a stdio child: declared env + PATH + HOME only.
 * Every other key the SDK would otherwise inherit is blanked out.
 */
export function buildStdioEnv(declared: EnvMap | null | undefined, baseEnv: NodeJS.ProcessEnv = process.env): EnvMap {
  const env: EnvMap = {};
  // Blank everything the SDK would merge in, so nothing leaks through it.
  for (const key of SDK_DEFAULT_ENV_KEYS) env[key] = "";
  for (const key of ALLOWED_INHERITED_ENV) {
    const value = baseEnv[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }
  if (declared) {
    for (const [key, value] of Object.entries(declared)) {
      if (typeof key !== "string" || key.length === 0 || key.includes("=") || key.includes("\0")) continue;
      env[key] = String(value);
    }
  }
  return env;
}

/** Fixed-size, line-oriented ring buffer for a child process' stderr. */
export class StderrRing {
  private readonly capacity: number;
  private readonly lines: string[] = [];
  private partial = "";

  constructor(capacity: number = STDERR_RING_SIZE) {
    this.capacity = Math.max(1, capacity);
  }

  /** Appends a raw chunk, splitting on newlines and buffering partial lines. */
  push(chunk: string): void {
    if (!chunk) return;
    this.partial += chunk;
    const parts = this.partial.split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    for (const line of parts) this.append(line);
  }

  /** Flushes a trailing partial line (on process exit). */
  flush(): void {
    if (this.partial.length > 0) {
      this.append(this.partial);
      this.partial = "";
    }
  }

  private append(line: string): void {
    if (line.length === 0) return;
    this.lines.push(line);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
  }

  toArray(): string[] {
    return [...this.lines];
  }

  clear(): void {
    this.lines.length = 0;
    this.partial = "";
  }

  get size(): number {
    return this.lines.length;
  }
}

export interface StdioUpstreamOptions {
  command: string;
  args?: string[] | null;
  cwd?: string | null;
  /** Declared env only; the isolation rules are applied here. */
  env?: EnvMap | null;
  clientInfo: Implementation;
  capabilities?: ClientCapabilities;
  /** Receives the upstream's notifications/<kind>/list_changed. */
  onListChanged?: (kind: "tools" | "prompts" | "resources") => void;
  /** Shared ring buffer owned by the manager (kept across restarts). */
  ring?: StderrRing;
}

export class StdioUpstream {
  readonly command: string;
  readonly args: string[];
  readonly cwd: string | null;
  readonly ring: StderrRing;

  private declaredEnv: EnvMap | null;
  private clientInfo: Implementation;
  private capabilities: ClientCapabilities | undefined;
  private onListChanged: ((kind: "tools" | "prompts" | "resources") => void) | undefined;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private lastExit: { code: number | null; signal: string | null } | null = null;

  constructor(options: StdioUpstreamOptions) {
    this.command = options.command;
    this.args = options.args ? [...options.args] : [];
    this.cwd = options.cwd ?? null;
    this.declaredEnv = options.env ?? null;
    this.clientInfo = options.clientInfo;
    this.capabilities = options.capabilities;
    this.onListChanged = options.onListChanged;
    this.ring = options.ring ?? new StderrRing();
  }

  get isRunning(): boolean {
    return this.client !== null;
  }

  get pid(): number | null {
    return this.transport?.pid ?? null;
  }

  get lastExitInfo(): { code: number | null; signal: string | null } | null {
    return this.lastExit;
  }

  /** Environment that will be passed to the child (exposed for tests / UI diagnostics). */
  childEnv(baseEnv: NodeJS.ProcessEnv = process.env): EnvMap {
    return buildStdioEnv(this.declaredEnv, baseEnv);
  }

  /**
   * Spawns the child and completes the MCP initialize handshake.
   * Returns the connected SDK client.
   */
  async start(): Promise<Client> {
    if (this.client) return this.client;

    const transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      cwd: this.cwd ?? undefined,
      env: this.childEnv(),
      // Pipe stderr so it can be kept in the ring buffer; "inherit" would leak it.
      stderr: "pipe",
    });
    this.transport = transport;

    // Attach before start(): the transport hands out the PassThrough immediately, so
    // early crash output is not lost.
    const stderrStream = transport.stderr;
    if (stderrStream && "on" in stderrStream) {
      stderrStream.on("data", (chunk: Buffer | string) => {
        this.ring.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      });
    }

    const client = new Client(this.clientInfo, {
      capabilities: this.capabilities,
      listChanged: this.listChangedHandlers(),
    });
    try {
      await client.connect(transport);
    } catch (error) {
      this.ring.flush();
      this.client = null;
      this.transport = null;
      await safeClose(client);
      const detail = this.ring.toArray().slice(-5).join(" | ");
      const suffix = detail ? ` (stderr: ${detail})` : "";
      throw new Error(`stdio upstream "${this.command}" failed to start: ${errorMessage(error)}${suffix}`);
    }

    client.onclose = () => {
      this.lastExit = { code: null, signal: null };
      this.ring.flush();
    };
    this.client = client;
    return client;
  }

  /** The live SDK client (throws when the child is not running). */
  sdkClient(): Client {
    if (!this.client) throw new Error(`stdio upstream "${this.command}" is not running`);
    return this.client;
  }

  /** Wires list_changed notifications to the caller, without auto-refreshing here. */
  private listChangedHandlers(): ListChangedHandlers | undefined {
    const notify = this.onListChanged;
    if (!notify) return undefined;
    return {
      tools: { autoRefresh: false, debounceMs: 0, onChanged: () => notify("tools") },
      prompts: { autoRefresh: false, debounceMs: 0, onChanged: () => notify("prompts") },
      resources: { autoRefresh: false, debounceMs: 0, onChanged: () => notify("resources") },
    };
  }

  /** Closes the client, which terminates the child process (SIGTERM then SIGKILL). */
  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.transport = null;
    this.ring.flush();
    if (client) await safeClose(client);
  }
}

async function safeClose(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    /* already closed */
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}
