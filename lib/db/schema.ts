import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

export const upstreams = sqliteTable("upstreams", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  transport: text("transport", { enum: ["http", "sse", "stdio"] }).notNull(),
  url: text("url"),
  command: text("command"),
  args: text("args", { mode: "json" }).$type<string[] | null>(),
  cwd: text("cwd"),
  envEnc: text("env_enc"),
  headersEnc: text("headers_enc"),
  authType: text("auth_type", { enum: ["none", "headers", "bearer", "oauth"] }).notNull().default("none"),
  oauthEnc: text("oauth_enc"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  startMode: text("start_mode", { enum: ["always", "lazy"] }).notNull().default("always"),
  idleStopMinutes: integer("idle_stop_minutes").notNull().default(15),
  callTimeoutSeconds: integer("call_timeout_seconds").notNull().default(120),
  status: text("status", {
    enum: ["connecting", "ready", "degraded", "auth_required", "error", "disabled"],
  })
    .notNull()
    .default("connecting"),
  lastError: text("last_error"),
  lastReadyAt: integer("last_ready_at"),
  capabilities: text("capabilities", { mode: "json" }),
  serverInfo: text("server_info", { mode: "json" }),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  uniqueIndex("upstreams_slug_unique").on(t.slug),
]);

export const upstreamItems = sqliteTable("upstream_items", {
  upstreamId: text("upstream_id").notNull(),
  kind: text("kind", { enum: ["tool", "prompt", "resource", "resource_template"] }).notNull(),
  name: text("name").notNull(),
  definition: text("definition", { mode: "json" }),
  fetchedAt: integer("fetched_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.upstreamId, t.kind, t.name] }),
]);

export const itemOverrides = sqliteTable("item_overrides", {
  upstreamId: text("upstream_id").notNull(),
  kind: text("kind", { enum: ["tool", "prompt", "resource", "resource_template"] }).notNull(),
  name: text("name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  alias: text("alias"),
  descriptionOverride: text("description_override"),
}, (t) => [primaryKey({ columns: [t.upstreamId, t.kind, t.name] })]);

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  prefix: text("prefix").notNull(),
  hash: text("hash").notNull(),
  scope: text("scope", { enum: ["agent", "admin"] }).notNull().default("agent"),
  exposureMode: text("exposure_mode", { enum: ["direct", "discovery"] }).notNull().default("direct"),
  expiresAt: integer("expires_at"),
  createdAt: integer("created_at").notNull(),
  lastUsedAt: integer("last_used_at"),
  revokedAt: integer("revoked_at"),
  rotatedAt: integer("rotated_at"),
  // Rotation grace: previous secret hash stays valid until this timestamp.
  prevHash: text("prev_hash"),
  prevHashExpiresAt: integer("prev_hash_expires_at"),
}, (t) => [uniqueIndex("api_keys_name_unique").on(t.name), index("api_keys_hash_idx").on(t.hash)]);

export const roles = sqliteTable("roles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: integer("created_at").notNull(),
}, (t) => [uniqueIndex("roles_name_unique").on(t.name)]);

export const keyRoles = sqliteTable("key_roles", {
  keyId: text("key_id").notNull(),
  roleId: text("role_id").notNull(),
}, (t) => [primaryKey({ columns: [t.keyId, t.roleId] })]);

export const grants = sqliteTable("grants", {
  id: text("id").primaryKey(),
  subjectType: text("subject_type", { enum: ["role", "key"] }).notNull(),
  subjectId: text("subject_id").notNull(),
  upstreamId: text("upstream_id").notNull(),
  toolMode: text("tool_mode", { enum: ["all", "selected"] }).notNull().default("all"),
  prompts: integer("prompts", { mode: "boolean" }).notNull().default(false),
  resources: integer("resources", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  uniqueIndex("grants_subject_upstream_unique").on(t.subjectType, t.subjectId, t.upstreamId),
  index("grants_subject_idx").on(t.subjectType, t.subjectId),
]);

export const grantTools = sqliteTable("grant_tools", {
  grantId: text("grant_id").notNull(),
  toolName: text("tool_name").notNull(),
}, (t) => [primaryKey({ columns: [t.grantId, t.toolName] })]);

export const keyDenies = sqliteTable("key_denies", {
  keyId: text("key_id").notNull(),
  upstreamId: text("upstream_id").notNull(),
  toolName: text("tool_name"),
}, (t) => [index("key_denies_key_idx").on(t.keyId)]);

export const toolDiscoveries = sqliteTable("tool_discoveries", {
  upstreamId: text("upstream_id").notNull(),
  toolName: text("tool_name").notNull(),
  firstSeenAt: integer("first_seen_at").notNull(),
  acknowledgedAt: integer("acknowledged_at"),
}, (t) => [primaryKey({ columns: [t.upstreamId, t.toolName] })]);

export const feedback = sqliteTable("feedback", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  keyId: text("key_id").notNull(),
  sessionId: text("session_id"),
  clientInfo: text("client_info", { mode: "json" }),
  category: text("category", {
    enum: ["tool_error", "missing_tool", "access_needed", "bad_description", "slow", "bug", "other"],
  }).notNull(),
  severity: text("severity", { enum: ["low", "medium", "high", "blocking"] }).notNull().default("medium"),
  title: text("title").notNull(),
  description: text("description").notNull(),
  upstreamSlug: text("upstream_slug"),
  toolName: text("tool_name"),
  attemptedAction: text("attempted_action"),
  errorMessage: text("error_message"),
  relatedCallId: text("related_call_id"),
  occurrences: integer("occurrences").notNull().default(1),
  lastOccurrenceAt: integer("last_occurrence_at").notNull(),
  status: text("status", {
    enum: ["new", "acknowledged", "in_progress", "resolved", "wont_fix"],
  }).notNull().default("new"),
  adminNote: text("admin_note"),
  resolvedAt: integer("resolved_at"),
});

export const callLogs = sqliteTable("call_logs", {
  id: text("id").primaryKey(),
  at: integer("at").notNull(),
  keyId: text("key_id"),
  sessionId: text("session_id"),
  upstreamId: text("upstream_id"),
  kind: text("kind").notNull(),
  name: text("name").notNull(),
  argsPreview: text("args_preview"),
  resultPreview: text("result_preview"),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  errorCode: text("error_code"),
  denied: integer("denied", { mode: "boolean" }).notNull().default(false),
  durationMs: integer("duration_ms"),
}, (t) => [
  index("call_logs_at_idx").on(t.at),
  index("call_logs_key_idx").on(t.keyId, t.at),
  index("call_logs_session_idx").on(t.sessionId, t.at),
]);

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  at: integer("at").notNull(),
  actor: text("actor").notNull(),
  type: text("type").notNull(),
  upstreamId: text("upstream_id"),
  message: text("message").notNull(),
  data: text("data", { mode: "json" }),
}, (t) => [index("events_at_idx").on(t.at)]);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }),
});

export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  upstreamId: text("upstream_id").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const toolSearch = sqliteTable("tool_search", {
  upstreamId: text("upstream_id").notNull(),
  toolName: text("tool_name").notNull(),
  publicName: text("public_name").notNull(),
  description: text("description"),
}, (t) => [index("tool_search_public_idx").on(t.publicName)]);
