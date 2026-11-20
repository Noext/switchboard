import type Database from "better-sqlite3";

/**
 * Idempotent, hand-rolled migrations. Runs at startup (and in tests).
 * Each entry is applied once, tracked in schema_migrations.
 */
type Migration = { id: string; sql: string };

const migrations: Migration[] = [
  {
    id: "001_initial",
    sql: `
    CREATE TABLE IF NOT EXISTS upstreams (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      transport TEXT NOT NULL,
      url TEXT,
      command TEXT,
      args TEXT,
      cwd TEXT,
      env_enc TEXT,
      headers_enc TEXT,
      auth_type TEXT NOT NULL DEFAULT 'none',
      oauth_enc TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      start_mode TEXT NOT NULL DEFAULT 'always',
      idle_stop_minutes INTEGER NOT NULL DEFAULT 15,
      call_timeout_seconds INTEGER NOT NULL DEFAULT 120,
      status TEXT NOT NULL DEFAULT 'connecting',
      last_error TEXT,
      last_ready_at INTEGER,
      capabilities TEXT,
      server_info TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS upstreams_slug_unique ON upstreams(slug);

    CREATE TABLE IF NOT EXISTS upstream_items (
      upstream_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      definition TEXT,
      fetched_at INTEGER NOT NULL,
      PRIMARY KEY (upstream_id, kind, name)
    );

    CREATE TABLE IF NOT EXISTS item_overrides (
      upstream_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      alias TEXT,
      description_override TEXT,
      PRIMARY KEY (upstream_id, kind, name)
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      prefix TEXT NOT NULL,
      hash TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'agent',
      exposure_mode TEXT NOT NULL DEFAULT 'direct',
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked_at INTEGER,
      rotated_at INTEGER,
      prev_hash TEXT,
      prev_hash_expires_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS api_keys_name_unique ON api_keys(name);
    CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys(hash);

    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS roles_name_unique ON roles(name);

    CREATE TABLE IF NOT EXISTS key_roles (
      key_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      PRIMARY KEY (key_id, role_id)
    );

    CREATE TABLE IF NOT EXISTS grants (
      id TEXT PRIMARY KEY,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      upstream_id TEXT NOT NULL,
      tool_mode TEXT NOT NULL DEFAULT 'all',
      prompts INTEGER NOT NULL DEFAULT 0,
      resources INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS grants_subject_upstream_unique ON grants(subject_type, subject_id, upstream_id);
    CREATE INDEX IF NOT EXISTS grants_subject_idx ON grants(subject_type, subject_id);

    CREATE TABLE IF NOT EXISTS grant_tools (
      grant_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      PRIMARY KEY (grant_id, tool_name)
    );

    CREATE TABLE IF NOT EXISTS key_denies (
      key_id TEXT NOT NULL,
      upstream_id TEXT NOT NULL,
      tool_name TEXT
    );
    CREATE INDEX IF NOT EXISTS key_denies_key_idx ON key_denies(key_id);

    CREATE TABLE IF NOT EXISTS tool_discoveries (
      upstream_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      first_seen_at INTEGER NOT NULL,
      acknowledged_at INTEGER,
      PRIMARY KEY (upstream_id, tool_name)
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      key_id TEXT NOT NULL,
      session_id TEXT,
      client_info TEXT,
      category TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      upstream_slug TEXT,
      tool_name TEXT,
      attempted_action TEXT,
      error_message TEXT,
      related_call_id TEXT,
      occurrences INTEGER NOT NULL DEFAULT 1,
      last_occurrence_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      admin_note TEXT,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS feedback_status_idx ON feedback(status, last_occurrence_at);

    CREATE TABLE IF NOT EXISTS call_logs (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      key_id TEXT,
      session_id TEXT,
      upstream_id TEXT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      args_preview TEXT,
      result_preview TEXT,
      ok INTEGER NOT NULL,
      error_code TEXT,
      denied INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS call_logs_at_idx ON call_logs(at);
    CREATE INDEX IF NOT EXISTS call_logs_key_idx ON call_logs(key_id, at);
    CREATE INDEX IF NOT EXISTS call_logs_session_idx ON call_logs(session_id, at);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      type TEXT NOT NULL,
      upstream_id TEXT,
      message TEXT NOT NULL,
      data TEXT
    );
    CREATE INDEX IF NOT EXISTS events_at_idx ON events(at);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      upstream_id TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tool_search (
      upstream_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      public_name TEXT NOT NULL,
      description TEXT
    );
    CREATE INDEX IF NOT EXISTS tool_search_public_idx ON tool_search(public_name);

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
    `,
  },
];

export function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set<string>(
    sqlite.prepare("SELECT id FROM schema_migrations").all().map((r: any) => r.id as string),
  );
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    const tx = sqlite.transaction(() => {
      sqlite.exec(m.sql);
      sqlite
        .prepare("INSERT OR REPLACE INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(m.id, Date.now());
    });
    tx();
  }
}

export function setupFts(sqlite: Database.Database): void {
  // FTS5 tables for discovery-mode search. Created best-effort (FTS may be unavailable).
  try {
    sqlite.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS tool_search_fts USING fts5(
        public_name, tool_name, description, params,
        content='', tokenize='unicode61'
      );
    `);
  } catch {
    /* FTS5 unavailable: discovery mode falls back to LIKE */
  }
}
