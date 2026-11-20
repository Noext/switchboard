import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Import tests (spec §8 "Import", §6.4):
 *  - Claude Code .mcp.json (`mcpServers`) with env + headers,
 *  - ~/.claude.json with global servers *and* per-project entries,
 *  - claude_desktop_config.json,
 *  - Codex config.toml ([mcp_servers.*] with url, bearer_token_env_var, env table, args, headers),
 * plus slug allocation, secret encryption on import and the §6.4 export shape.
 */

let dir: string;
let dbmod: typeof import("../lib/db");
const envBackup = { ...process.env };

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-import-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");
  process.env.SWITCHBOARD_PUBLIC_URL = "https://switchboard.example.com";
  vi.resetModules();
  dbmod = await import("../lib/db");
});

afterEach(async () => {
  dbmod?.closeDb();
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...envBackup };
});

const CLAUDE_CODE_JSON = JSON.stringify(
  {
    mcpServers: {
      github: {
        type: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: {
          Authorization: "Bearer ghp_supersecrettoken1234567890",
          "X-Api-Key": "abc123",
        },
      },
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
        env: { HOME: "/root", API_TOKEN: "env-secret-value" },
      },
      legacy: { type: "sse", url: "https://legacy.example.com/sse" },
    },
  },
  null,
  2,
);

const CLAUDE_GLOBAL_JSON = JSON.stringify(
  {
    numStartups: 42,
    mcpServers: {
      switchboard: {
        type: "http",
        url: "https://switchboard.example.com/mcp",
        headers: { Authorization: "Bearer sk-sw-abcdefghijklmnopqrstuvwx" },
      },
    },
    projects: {
      "/root/Dev/project-a": {
        mcpServers: {
          toto: { command: "python", args: ["server.py"], env: { DB_PASSWORD: "pg-secret" } },
        },
      },
      "/root/Dev/project-b": {
        mcpServers: {
          jira: { type: "http", url: "https://jira.example.com/mcp", headers: { "X-API-Key": "jira-key-value" } },
        },
      },
    },
  },
  null,
  2,
);

const CLAUDE_DESKTOP_JSON = JSON.stringify(
  {
    globalShortcut: "Ctrl+Space",
    mcpServers: {
      "local-files": {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/Documents"],
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", SECRET_KEY: "desktop-secret" },
      },
      memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
    },
  },
  null,
  2,
);

const CODEX_TOML = `
model = "gpt-5"
approval_policy = "on-request"

[mcp_servers.switchboard]
url = "https://switchboard.example.com/mcp"
bearer_token_env_var = "SWITCHBOARD_KEY"

[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = { GITHUB_TOKEN = "ghp_fromtoml1234567890", DEBUG = "1" }

[mcp_servers.jira]
url = "https://jira.example.com/mcp"
http_headers = { "X-Api-Key" = "toml-jira-key", "Authorization" = "Bearer toml-bearer-token-value" }
startup_timeout_sec = 30

# A stdio server with a nested [env] table (Codex style).
[mcp_servers.postgres.env]
DATABASE_URL = "postgres://user:pass@localhost/db"
`;

describe("Claude Code .mcp.json", () => {
  it("parses http + stdio servers with env and headers", async () => {
    const { parseClaudeCodeJson } = await import("../lib/import/claude-code");
    const parsed = parseClaudeCodeJson(CLAUDE_CODE_JSON);
    expect(parsed.format).toBe("claude-code");
    const names = parsed.servers.map((s) => s.name).sort();
    expect(names).toEqual(["filesystem", "github", "legacy"]);

    const github = parsed.servers.find((s) => s.name === "github")!;
    expect(github.transport).toBe("http");
    expect(github.url).toBe("https://api.githubcopilot.com/mcp/");
    // A Bearer Authorization header means the upstream is bearer-authenticated.
    expect(github.authType).toBe("bearer");
    expect(Object.keys(github.headers).sort()).toEqual(["Authorization", "X-Api-Key"]);

    const fs = parsed.servers.find((s) => s.name === "filesystem")!;
    expect(fs.transport).toBe("stdio");
    expect(fs.command).toBe("npx");
    expect(fs.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]);
    expect(fs.env.API_TOKEN).toBe("env-secret-value");
    expect(fs.headers).toEqual({});

    expect(parsed.servers.find((s) => s.name === "legacy")!.transport).toBe("sse");
  });

  it("detects every secret location and strips values from the preview", async () => {
    const { previewImport } = await import("../lib/import");
    const preview = previewImport(CLAUDE_CODE_JSON, "claude-code");

    const github = preview.servers.find((s) => s.name === "github")!;
    expect(github.headerKeys.sort()).toEqual(["Authorization", "X-Api-Key"]);
    expect(github.envKeys).toEqual([]);
    expect(github.hasSecrets).toBe(true);
    expect(github.secrets).toEqual(
      expect.arrayContaining([
        { location: "header", key: "Authorization" },
        { location: "header", key: "X-Api-Key" },
      ]),
    );

    const fs = preview.servers.find((s) => s.name === "filesystem")!;
    expect(fs.envKeys.sort()).toEqual(["API_TOKEN", "HOME"]);
    expect(fs.secrets).toEqual(
      expect.arrayContaining([
        { location: "env", key: "API_TOKEN" },
        { location: "env", key: "HOME" },
      ]),
    );

    // The serialized preview must never contain a secret value.
    const json = JSON.stringify(preview);
    expect(json).not.toContain("ghp_supersecrettoken1234567890");
    expect(json).not.toContain("env-secret-value");
    expect(preview.counts.servers).toBe(3);
    expect(preview.counts.stdio).toBe(1);
    expect(preview.counts.http).toBe(2);
    expect(preview.counts.secrets).toBe(4);
  });

  it("rejects invalid JSON with a clear error", async () => {
    const { parseClaudeCodeJson, ImportParseError } = await import("../lib/import/claude-code");
    expect(() => parseClaudeCodeJson("{ nope ")).toThrow(ImportParseError);
  });

  it("warns and skips entries that have neither url nor command", async () => {
    const { parseClaudeCodeJson } = await import("../lib/import/claude-code");
    const parsed = parseClaudeCodeJson(JSON.stringify({ mcpServers: { broken: { type: "http" }, ok: { command: "x" } } }));
    expect(parsed.servers.map((s) => s.name)).toEqual(["ok"]);
    expect(parsed.warnings.join(" ")).toContain("neither");
  });
});

describe("~/.claude.json (global + per-project)", () => {
  it("collects the global mcpServers and every projects[].mcpServers entry", async () => {
    const { parseClaudeCodeJson } = await import("../lib/import/claude-code");
    const parsed = parseClaudeCodeJson(CLAUDE_GLOBAL_JSON);
    expect(parsed.servers.map((s) => s.name).sort()).toEqual(["jira", "switchboard", "toto"]);

    const global = parsed.servers.find((s) => s.name === "switchboard")!;
    expect(global.scope).toBe("global");
    expect(global.projects).toEqual([]);
    expect(global.authType).toBe("bearer");

    const toto = parsed.servers.find((s) => s.name === "toto")!;
    expect(toto.scope).toBe("project:/root/Dev/project-a");
    expect(toto.projects).toEqual(["/root/Dev/project-a"]);
    expect(toto.env.DB_PASSWORD).toBe("pg-secret");

    const jira = parsed.servers.find((s) => s.name === "jira")!;
    expect(jira.projects).toEqual(["/root/Dev/project-b"]);
    expect(jira.authType).toBe("headers");
  });

  it("merges the same server declared globally and in a project", async () => {
    const { parseClaudeCodeJson } = await import("../lib/import/claude-code");
    const doc = {
      mcpServers: { shared: { command: "npx", args: ["server"] } },
      projects: { "/p/a": { mcpServers: { shared: { command: "npx", args: ["server"] } } } },
    };
    const parsed = parseClaudeCodeJson(JSON.stringify(doc));
    expect(parsed.servers.length).toBe(1);
    expect(parsed.servers[0].projects).toEqual(["/p/a"]);
  });

  it("is detected as the claude-code format", async () => {
    const { detectFormat } = await import("../lib/import");
    expect(detectFormat(CLAUDE_GLOBAL_JSON)).toBe("claude-code");
    expect(detectFormat(CLAUDE_DESKTOP_JSON)).toBe("claude-desktop");
    expect(detectFormat(CODEX_TOML)).toBe("codex");
  });
});

describe("claude_desktop_config.json", () => {
  it("parses stdio servers and flags a PATH override", async () => {
    const { parseClaudeDesktopJson } = await import("../lib/import/claude-desktop");
    const parsed = parseClaudeDesktopJson(CLAUDE_DESKTOP_JSON);
    expect(parsed.format).toBe("claude-desktop");
    expect(parsed.servers.map((s) => s.name).sort()).toEqual(["local-files", "memory"]);

    const files = parsed.servers.find((s) => s.name === "local-files")!;
    expect(files.transport).toBe("stdio");
    expect(files.env.SECRET_KEY).toBe("desktop-secret");
    expect(files.warnings.join(" ")).toContain("PATH");

    const preview = (await import("../lib/import")).previewImport(CLAUDE_DESKTOP_JSON, "claude-desktop");
    expect(JSON.stringify(preview)).not.toContain("desktop-secret");
    expect(preview.servers.find((s) => s.name === "local-files")!.envKeys.sort()).toEqual(["PATH", "SECRET_KEY"]);
  });

  it("warns when mcpServers is absent", async () => {
    const { parseClaudeDesktopJson } = await import("../lib/import/claude-desktop");
    const parsed = parseClaudeDesktopJson(JSON.stringify({ globalShortcut: "x" }));
    expect(parsed.servers).toEqual([]);
    expect(parsed.warnings.join(" ")).toContain("mcpServers");
  });
});

describe("Codex config.toml", () => {
  it("parses url + bearer_token_env_var, env tables, args and http_headers", async () => {
    const { parseCodexToml } = await import("../lib/import/codex");
    const parsed = parseCodexToml(CODEX_TOML);
    expect(parsed.format).toBe("codex");
    // `postgres` only exists as `[mcp_servers.postgres.env]`: no url/command, so it is skipped.
    const names = parsed.servers.map((s) => s.name).sort();
    expect(names).toEqual(["github", "jira", "switchboard"]);

    // url + bearer_token_env_var, token not in the environment
    const sb = parsed.servers.find((s) => s.name === "switchboard")!;
    expect(sb.transport).toBe("http");
    expect(sb.url).toBe("https://switchboard.example.com/mcp");
    expect(sb.bearerTokenEnvVar).toBe("SWITCHBOARD_KEY");
    expect(sb.authType).toBe("bearer");
    expect(sb.warnings.join(" ")).toContain("SWITCHBOARD_KEY");

    // stdio with an inline env table and an args array
    const github = parsed.servers.find((s) => s.name === "github")!;
    expect(github.transport).toBe("stdio");
    expect(github.command).toBe("npx");
    expect(github.args).toEqual(["-y", "@modelcontextprotocol/server-github"]);
    expect(github.env).toEqual({ GITHUB_TOKEN: "ghp_fromtoml1234567890", DEBUG: "1" });

    // http_headers inline table -> headers, Bearer -> bearer auth
    const jira = parsed.servers.find((s) => s.name === "jira")!;
    expect(jira.transport).toBe("http");
    expect(jira.authType).toBe("bearer");
    expect(jira.headers["X-Api-Key"]).toBe("toml-jira-key");

    // Nested [mcp_servers.postgres.env] table with no url/command is skipped (no connection info),
    // and the parser must not crash on it.
    expect(parsed.servers.find((s) => s.name === "postgres")).toBeUndefined();
    expect(parsed.warnings.join(" ")).toContain("postgres");
  });

  it("resolves bearer_token_env_var from the process environment", async () => {
    process.env.MY_CODEX_TOKEN = "resolved-token-value";
    try {
      const { parseCodexToml } = await import("../lib/import/codex");
      const parsed = parseCodexToml(`
[mcp_servers.sb]
url = "https://example.com/mcp"
bearer_token_env_var = "MY_CODEX_TOKEN"
`);
      const sb = parsed.servers[0];
      expect(sb.headers.Authorization).toBe("Bearer resolved-token-value");
      expect(sb.authType).toBe("bearer");
      expect(sb.warnings.join(" ")).not.toContain("not set");
    } finally {
      delete process.env.MY_CODEX_TOKEN;
    }
  });

  it("keeps secret values out of the preview", async () => {
    const { previewImport } = await import("../lib/import");
    const preview = previewImport(CODEX_TOML, "codex");
    const json = JSON.stringify(preview);
    expect(json).not.toContain("ghp_fromtoml1234567890");
    expect(json).not.toContain("toml-jira-key");
    expect(json).not.toContain("toml-bearer-token-value");

    const github = preview.servers.find((s) => s.name === "github")!;
    expect(github.envKeys.sort()).toEqual(["DEBUG", "GITHUB_TOKEN"]);
    const sb = preview.servers.find((s) => s.name === "switchboard")!;
    expect(sb.bearerTokenEnvVar).toBe("SWITCHBOARD_KEY");
    expect(sb.secrets).toEqual(expect.arrayContaining([{ location: "bearer_token_env_var", key: "SWITCHBOARD_KEY" }]));
  });

  it("reports a TOML syntax error with its line number", async () => {
    const { parseCodexToml } = await import("../lib/import/codex");
    const { ImportParseError } = await import("../lib/import/claude-code");
    expect(() => parseCodexToml("[mcp_servers\nbroken = ")).toThrow(ImportParseError);
    expect(() => parseCodexToml('model = "x"\n[mcp_servers.a]\nurl = "u"\nbad')).toThrow(/TOML line 4/);
  });
});

describe("minimal TOML parser", () => {
  it("handles tables, arrays, inline tables, strings and comments", async () => {
    const { parseToml } = await import("../lib/import/toml");
    const doc = parseToml(`
# comment
title = "hello # not a comment"
literal = 'raw \\n value'
number = 42
float = 1.5
flag = true
list = ["a", "b", 3]
inline = { k = "v", n = 2 }

[server]
host = "example.com"   # trailing comment
port = 8080

[server.tls]
enabled = false
`);
    expect(doc.title).toBe("hello # not a comment");
    expect(doc.literal).toBe("raw \\n value");
    expect(doc.number).toBe(42);
    expect(doc.float).toBe(1.5);
    expect(doc.flag).toBe(true);
    expect(doc.list).toEqual(["a", "b", 3]);
    expect(doc.inline).toEqual({ k: "v", n: 2 });
    expect((doc.server as Record<string, unknown>).host).toBe("example.com");
    expect((doc.server as Record<string, unknown>).port).toBe(8080);
    expect(((doc.server as Record<string, unknown>).tls as Record<string, unknown>).enabled).toBe(false);
  });

  it("supports arrays of tables and dotted keys", async () => {
    const { parseToml } = await import("../lib/import/toml");
    const doc = parseToml(`
a.b.c = 1

[[items]]
name = "a"

[[items]]
name = "b"
`);
    expect(doc.a).toEqual({ b: { c: 1 } });
    expect(doc.items).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("supports multi-line arrays", async () => {
    const { parseToml } = await import("../lib/import/toml");
    const doc = parseToml(`
args = [
  "-y",
  "server",
  "--flag",
]
`);
    expect(doc.args).toEqual(["-y", "server", "--flag"]);
  });
});

describe("preview + slug allocation", () => {
  it("slugifies names and dedupes against existing upstreams", async () => {
    const { allocateSlug } = await import("../lib/import");
    const taken = new Set<string>();
    expect(allocateSlug("My Server", taken)).toBe("myserver");
    expect(allocateSlug("toto", new Set(["toto"]))).toBe("toto2");
    expect(allocateSlug("toto", new Set(["toto", "toto2"]))).toBe("toto3");
    // Names that slugify to nothing fall back to "mcp".
    expect(allocateSlug("!!!", taken)).toBe("mcp");
    // Long names are truncated to <= 12 chars.
    expect(allocateSlug("a-very-long-server-name", taken).length).toBeLessThanOrEqual(12);
  });

  it("marks a preview slug as taken when an upstream already uses it", async () => {
    const { upstreams } = await import("../lib/db/schema");
    dbmod.getDb()
      .insert(upstreams)
      .values({
        id: "u1",
        slug: "github",
        name: "GitHub",
        transport: "http",
        url: "http://x/mcp",
        authType: "none",
        enabled: true,
        status: "ready",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run();
    const { previewImport } = await import("../lib/import");
    const preview = previewImport(CLAUDE_CODE_JSON, "claude-code");
    const github = preview.servers.find((s) => s.name === "github")!;
    expect(github.slugTaken).toBe(true);
    expect(github.slug).toBe("github2");
  });
});

describe("importServers", () => {
  it("creates upstreams, encrypts secrets and infers the auth type", async () => {
    const { importServers } = await import("../lib/import");
    const result = importServers([
      {
        name: "github",
        transport: "http",
        url: "https://api.githubcopilot.com/mcp/",
        headers: { Authorization: "Bearer ghp_tokenvalue123456", "X-Api-Key": "abc" },
      },
      {
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        args: ["-y", "server"],
        env: { API_TOKEN: "env-secret-value" },
      },
    ]);

    expect(result.created).toEqual(["github", "filesystem"]);
    expect(result.createdSlugs).toEqual(["github", "filesystem"]);
    expect(result.skipped).toEqual([]);

    const { upstreams } = await import("../lib/db/schema");
    const rows = dbmod.getDb().select().from(upstreams).all();
    const byName = new Map(rows.map((r) => [r.name, r]));

    const gh = byName.get("github")!;
    expect(gh.transport).toBe("http");
    expect(gh.authType).toBe("bearer");
    expect(gh.enabled).toBe(true);
    expect(gh.status).toBe("connecting");
    expect(gh.envEnc).toBeNull();
    // Secrets are stored encrypted, never in clear.
    expect(gh.headersEnc).toBeTruthy();
    expect(gh.headersEnc).not.toContain("ghp_tokenvalue123456");
    const { decodeEncRecord } = await import("../lib/import");
    expect(decodeEncRecord(gh.headersEnc!)).toEqual({
      Authorization: "Bearer ghp_tokenvalue123456",
      "X-Api-Key": "abc",
    });

    const fs = byName.get("filesystem")!;
    expect(fs.transport).toBe("stdio");
    expect(fs.command).toBe("npx");
    expect(fs.args).toEqual(["-y", "server"]);
    expect(fs.headersEnc).toBeNull();
    expect(decodeEncRecord(fs.envEnc!)).toEqual({ API_TOKEN: "env-secret-value" });
    expect(result.warnings.join(" ")).toContain("stdio");
  });

  it("assigns unique slugs and honours an explicit valid slug", async () => {
    const { importServers } = await import("../lib/import");
    const first = importServers([{ name: "toto", url: "http://a/mcp" }]);
    expect(first.createdSlugs).toEqual(["toto"]);
    const second = importServers([{ name: "toto", url: "http://b/mcp" }]);
    expect(second.createdSlugs).toEqual(["toto2"]);
    const third = importServers([{ name: "toto", slug: "mytoto", url: "http://c/mcp" }]);
    expect(third.createdSlugs).toEqual(["mytoto"]);
  });

  it("skips invalid selections with a reason", async () => {
    const { importServers } = await import("../lib/import");
    const result = importServers([
      { name: "no-url", transport: "http" },
      { name: "bad-slug", slug: "!!!", url: "http://x/mcp" },
      { name: "no-command", transport: "stdio" },
    ]);
    expect(result.created).toEqual([]);
    expect(result.skipped.sort()).toEqual(["bad-slug", "no-command", "no-url"]);
    expect(result.skippedReasons["no-url"]).toMatch(/url/i);
    expect(result.skippedReasons["no-command"]).toMatch(/command/i);
    expect(result.skippedReasons["bad-slug"]).toMatch(/slug/i);

    // A messy slug is normalised rather than rejected.
    const salvaged = importServers([{ name: "messy", slug: "My Server!", url: "http://x/mcp" }]);
    expect(salvaged.createdSlugs).toEqual(["myserver"]);
  });

  it("flags a bearer import whose token was unavailable", async () => {
    const { importServers } = await import("../lib/import");
    const result = importServers([
      { name: "codex-sb", url: "https://x/mcp", authType: "bearer", bearerTokenEnvVar: "SWITCHBOARD_KEY" },
    ]);
    expect(result.created).toEqual(["codex-sb"]);
    expect(result.needsAttention.length).toBe(1);
    expect(result.needsAttention[0].reason).toContain("SWITCHBOARD_KEY");
  });

  it("does not fail when no upstream manager is initialised", async () => {
    const { hasUpstreamManager } = await import("../lib/upstreams/types");
    expect(hasUpstreamManager()).toBe(false);
    const { importServers } = await import("../lib/import");
    expect(() => importServers([{ name: "x", url: "http://x/mcp" }])).not.toThrow();
  });
});

describe("exportConfigForKey (§6.4)", () => {
  it("returns the MCP URL and the three snippets for a key", async () => {
    const { apiKeys, upstreams, upstreamItems } = await import("../lib/db/schema");
    const now = Date.now();
    dbmod.getDb()
      .insert(apiKeys)
      .values({
        id: "key-1",
        name: "claude-laptop",
        prefix: "sk-sw-abcde",
        hash: "h1",
        scope: "agent",
        exposureMode: "direct",
        createdAt: now,
      })
      .run();
    dbmod.getDb()
      .insert(upstreams)
      .values({
        id: "u1",
        slug: "toto",
        name: "Toto",
        transport: "http",
        url: "http://localhost:9/mcp",
        authType: "none",
        enabled: true,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    dbmod.getDb()
      .insert(upstreamItems)
      .values({ upstreamId: "u1", kind: "tool", name: "B", definition: { name: "B" }, fetchedAt: now })
      .run();
    const { upsertGrant } = await import("../lib/auth/grants");
    upsertGrant({ subjectType: "key", subjectId: "key-1", upstreamId: "u1", toolMode: "all" });
    const { invalidateCatalog } = await import("../lib/catalog/catalog");
    invalidateCatalog("test");

    const { exportConfigForKey } = await import("../lib/import");
    const exported = exportConfigForKey("key-1", { secret: "sk-sw-realsecretvalue" })!;
    expect(exported).not.toBeNull();
    expect(exported.key.name).toBe("claude-laptop");
    expect(exported.mcpUrl).toBe("https://switchboard.example.com/mcp");
    expect(exported.upstreams.map((u) => u.slug)).toEqual(["toto"]);
    expect(exported.upstreams[0].toolNames).toEqual(["B"]);
    expect(exported.totals.tools).toBe(1);

    expect(exported.snippets.claudeCodeCommand).toContain("claude mcp add --scope user --transport http switchboard");
    expect(exported.snippets.claudeCodeCommand).toContain("sk-sw-realsecretvalue");
    expect(exported.snippets.codexToml).toContain("[mcp_servers.switchboard]");
    expect(exported.snippets.codexToml).toContain('bearer_token_env_var = "SWITCHBOARD_KEY"');
    expect(JSON.parse(exported.snippets.mcpJson).mcpServers.switchboard.url).toBe(
      "https://switchboard.example.com/mcp",
    );

    // Without a secret, a placeholder is emitted instead of leaking anything.
    const noSecret = exportConfigForKey("key-1")!;
    expect(noSecret.snippets.mcpJson).not.toContain("sk-sw-realsecretvalue");
    expect(noSecret.snippets.mcpJson).toContain("sk-sw-xxxxxxxx");
  });

  it("returns null for an unknown key", async () => {
    const { exportConfigForKey } = await import("../lib/import");
    expect(exportConfigForKey("nope")).toBeNull();
  });
});
describe("format detection with real payloads", () => {
  it("detects TOML even though it starts with a bracket", async () => {
    const { detectFormat } = await import("../lib/import");
    expect(detectFormat('[mcp_servers.sb]\nurl = "https://x/mcp"\n')).toBe("codex");
    // A bare "key = value" TOML document without a table header.
    expect(detectFormat('model = "gpt-5"\n')).toBe("codex");
    // A JSON array is not a client config: it must not be mistaken for TOML.
    expect(detectFormat("[1, 2, 3]")).toBe("claude-code");
  });
});

describe("/api/v1/import route", () => {
  async function cookie(): Promise<string> {
    const { createSessionToken, SESSION_COOKIE } = await import("../lib/auth/session");
    return SESSION_COOKIE + "=" + createSessionToken();
  }

  async function post(body: unknown) {
    const { POST } = await import("../app/api/v1/import/route");
    return POST(
      new Request("http://localhost/api/v1/import", {
        method: "POST",
        headers: { cookie: await cookie(), "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  }

  it("returns a secret-free preview by default", async () => {
    const res = await post({ payload: CLAUDE_CODE_JSON, format: "claude-code" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("preview");
    expect(body.preview.counts.servers).toBe(3);
    expect(JSON.stringify(body)).not.toContain("ghp_supersecrettoken1234567890");
    expect(JSON.stringify(body)).not.toContain("env-secret-value");
  });

  it("detects the Codex format from a payload with no explicit format", async () => {
    const res = await post({ payload: CODEX_TOML });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.preview.format).toBe("codex");
    expect(body.preview.servers.map((s: { name: string }) => s.name)).toContain("switchboard");
  });

  it("creates upstreams and applies the access section", async () => {
    const { apiKeys } = await import("../lib/db/schema");
    dbmod.getDb()
      .insert(apiKeys)
      .values({
        id: "k1",
        name: "claude-laptop",
        prefix: "sk-sw-abcde",
        hash: "h1",
        scope: "agent",
        exposureMode: "direct",
        createdAt: Date.now(),
      })
      .run();

    const res = await post({
      preview: false,
      selection: [{ name: "github", slug: "gh", transport: "http", url: "https://gh/mcp" }],
      access: { subjects: [{ subjectType: "key", subjectId: "k1", toolMode: "all" }] },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("import");
    expect(body.created).toEqual(["github"]);
    expect(body.createdSlugs).toEqual(["gh"]);

    const { grantFor } = await import("../lib/auth/grants");
    const { upstreams } = await import("../lib/db/schema");
    const row = dbmod.getDb().select().from(upstreams).all()[0];
    const grant = grantFor("key", "k1", row.id);
    expect(grant).not.toBeNull();
    expect(grant!.toolMode).toBe("all");
  });

  it("rejects a bad payload, an empty request and an empty selection", async () => {
    const bad = await post({ payload: "{ broken" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Invalid JSON/);

    const empty = await post({});
    expect(empty.status).toBe(400);

    const noSelection = await post({ preview: false, selection: [] });
    expect(noSelection.status).toBe(400);
  });

  it("requires admin authentication", async () => {
    const { POST } = await import("../app/api/v1/import/route");
    const res = await POST(
      new Request("http://localhost/api/v1/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: CLAUDE_CODE_JSON }),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe("/api/v1/discoveries routes", () => {
  async function cookie(): Promise<string> {
    const { createSessionToken, SESSION_COOKIE } = await import("../lib/auth/session");
    return SESSION_COOKIE + "=" + createSessionToken();
  }

  async function seed() {
    const { apiKeys, upstreams, roles, toolDiscoveries } = await import("../lib/db/schema");
    const now = Date.now();
    dbmod.getDb()
      .insert(apiKeys)
      .values({
        id: "k1",
        name: "claude-laptop",
        prefix: "sk-sw-abcde",
        hash: "h1",
        scope: "agent",
        exposureMode: "direct",
        createdAt: now,
      })
      .run();
    dbmod.getDb().insert(roles).values({ id: "r1", name: "dev", createdAt: now }).run();
    dbmod.getDb()
      .insert(upstreams)
      .values({
        id: "u1",
        slug: "toto",
        name: "Toto",
        transport: "http",
        url: "http://x/mcp",
        authType: "none",
        enabled: true,
        status: "ready",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    dbmod.getDb().insert(toolDiscoveries).values({ upstreamId: "u1", toolName: "D", firstSeenAt: now }).run();

    const { upsertGrant } = await import("../lib/auth/grants");
    upsertGrant({ subjectType: "key", subjectId: "k1", upstreamId: "u1", toolMode: "selected", tools: ["A"] });
    upsertGrant({ subjectType: "role", subjectId: "r1", upstreamId: "u1", toolMode: "all" });
  }

  it("lists pending discoveries with auto-granted and pending subjects", async () => {
    await seed();
    const { GET } = await import("../app/api/v1/discoveries/route");
    const res = await GET(new Request("http://localhost/api/v1/discoveries", { headers: { cookie: await cookie() } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.pending).toBe(1);
    const row = body.items[0];
    expect(row.toolName).toBe("D");
    expect(row.publicName).toBe("toto__D");
    // The role is in "all" mode so it already has the tool; the key is in "selected" mode.
    expect(row.autoGranted.map((s: { label: string }) => s.label)).toEqual(["dev"]);
    expect(row.pending.map((s: { label: string }) => s.label)).toEqual(["claude-laptop"]);
  });

  it("grants the new tool to a selected subject and acknowledges the discovery", async () => {
    await seed();
    const { POST } = await import("../app/api/v1/discoveries/grant/route");
    const headers = { cookie: await cookie(), "content-type": "application/json" };
    const res = await POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers,
        body: JSON.stringify({
          upstreamId: "u1",
          toolName: "D",
          subjects: [
            { subjectType: "key", subjectId: "k1" },
            { subjectType: "role", subjectId: "r1" },
          ],
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.granted.map((g: { subjectType: string }) => g.subjectType)).toEqual(["key"]);
    expect(body.skipped.map((s: { subjectType: string }) => s.subjectType)).toEqual(["role"]);
    expect(body.skipped[0].reason).toMatch(/every tool/i);

    const { grantFor } = await import("../lib/auth/grants");
    expect(grantFor("key", "k1", "u1")!.tools.sort()).toEqual(["A", "D"]);

    // Granting from the banner acknowledges the discovery.
    const { listDiscoveries, pendingDiscoveryCount } = await import("../app/api/v1/discoveries/_lib");
    expect(listDiscoveries()).toEqual([]);
    expect(pendingDiscoveryCount()).toBe(0);
  });

  it("creates a selected grant when the subject had none", async () => {
    await seed();
    const { POST } = await import("../app/api/v1/discoveries/grant/route");
    const { apiKeys } = await import("../lib/db/schema");
    dbmod.getDb()
      .insert(apiKeys)
      .values({
        id: "k2",
        name: "codex-perso",
        prefix: "sk-sw-fghij",
        hash: "h2",
        scope: "agent",
        exposureMode: "direct",
        createdAt: Date.now(),
      })
      .run();

    const res = await POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { cookie: await cookie(), "content-type": "application/json" },
        body: JSON.stringify({ upstreamId: "u1", toolName: "D", subjects: [{ subjectType: "key", subjectId: "k2" }] }),
      }),
    );
    const body = await res.json();
    expect(body.granted[0].created).toBe(true);

    const { grantFor } = await import("../lib/auth/grants");
    const grant = grantFor("key", "k2", "u1")!;
    expect(grant.toolMode).toBe("selected");
    expect(grant.tools).toEqual(["D"]);
  });

  it("404s when the upstream does not exist", async () => {
    const { POST } = await import("../app/api/v1/discoveries/grant/route");
    const res = await POST(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { cookie: await cookie(), "content-type": "application/json" },
        body: JSON.stringify({ upstreamId: "ghost", toolName: "D", subjects: [{ subjectType: "key", subjectId: "k1" }] }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("acknowledges one discovery, or a whole upstream, idempotently", async () => {
    await seed();
    const { toolDiscoveries } = await import("../lib/db/schema");
    dbmod.getDb().insert(toolDiscoveries).values({ upstreamId: "u1", toolName: "E", firstSeenAt: Date.now() }).run();

    const { POST } = await import("../app/api/v1/discoveries/ack/route");
    const headers = { cookie: await cookie(), "content-type": "application/json" };
    const post = (body: unknown) =>
      POST(new Request("http://localhost/x", { method: "POST", headers, body: JSON.stringify(body) }));

    const one = await post({ upstreamId: "u1", toolName: "D" });
    expect(one.status).toBe(200);
    expect((await one.json()).acknowledged).toBe(1);

    const rest = await post({ items: [{ upstreamId: "u1" }] });
    expect((await rest.json()).acknowledged).toBe(1);

    const again = await post({ upstreamId: "u1" });
    expect((await again.json()).acknowledged).toBe(0);

    const { GET } = await import("../app/api/v1/discoveries/route");
    const listed = await GET(
      new Request("http://localhost/api/v1/discoveries?includeAcknowledged=true", { headers }),
    );
    expect((await listed.json()).total).toBe(2);
  });
});
