/** Shared domain types used across DB, catalog, gateway and UI. */

export type UpstreamTransport = "http" | "sse" | "stdio";
export type AuthType = "none" | "headers" | "bearer" | "oauth";
export type UpstreamStatus =
  | "connecting"
  | "ready"
  | "degraded"
  | "auth_required"
  | "error"
  | "disabled";
export type ItemKind = "tool" | "prompt" | "resource" | "resource_template";
export type SubjectType = "role" | "key";
export type ToolMode = "all" | "selected";
export type ExposureMode = "direct" | "discovery";
export type KeyScope = "agent" | "admin";

export interface UpstreamItemDef {
  name?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  uri?: string;
  uriTemplate?: string;
  mimeType?: string;
  title?: string;
  arguments?: unknown;
}

export interface CatalogEntry {
  kind: ItemKind;
  /** Original name in the upstream (tool name, prompt name, resource uri). */
  name: string;
  /** Public name exposed to clients: `<slug>__<name>` for tools/prompts, uri or switchboard:// for resources. */
  publicName: string;
  upstreamId: string;
  upstreamSlug: string;
  description?: string;
  definition: UpstreamItemDef;
  enabled: boolean;
  alias?: string | null;
  descriptionOverride?: string | null;
  truncated?: boolean;
}

export interface UpstreamRuntimeState {
  id: string;
  slug: string;
  status: UpstreamStatus;
  lastError: string | null;
  serverInfo?: { name?: string; version?: string } | null;
  capabilities?: Record<string, unknown> | null;
  stderrRing?: string[];
}

/** A grant flattened for access computation. */
export interface AccessGrant {
  grantId: string;
  upstreamId: string;
  toolMode: ToolMode;
  tools: string[];
  prompts: boolean;
  resources: boolean;
  /** Where the grant comes from, for UI badges. */
  source: { type: SubjectType; id: string; label: string };
}

/** The effective, computed view of what a key may see/do. */
export interface EffectiveAccess {
  keyId: string;
  upstreams: Record<string, EffectiveUpstreamAccess>;
  /** Convenience: all visible public tool names. */
  publicTools: string[];
}

export interface EffectiveUpstreamAccess {
  upstreamId: string;
  upstreamSlug: string;
  /** Original tool names visible to the key. */
  tools: string[];
  /** Tools visible through a grant but explicitly denied on the key. */
  deniedTools: string[];
  prompts: null | string[];
  resources: null | string[];
  hasAccess: boolean;
  /** Grant sources granting at least partially, for UI badges. */
  sources: AccessGrant["source"][];
  /** Tools granted by a role but removed for this key. */
  removedByDeny: string[];
  /** Tools disabled globally by overrides. */
  disabledGlobally: string[];
}
