import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Route-handler level tests for the admin REST API (spec §9).
 *
 * The handlers are plain `(req: Request, ctx) => Response` functions, so they can be called
 * directly with a Request built in-process — no HTTP server needed. Environment is configured
 * before the first dynamic import so `lib/config.ts` / `lib/crypto.ts` see the temp data dir.
 */

let dir: string;
let mod: {
  guard: typeof import("@/lib/api/guard");
  session: typeof import("@/app/api/v1/session/route");
  upstreamsRoute: typeof import("@/app/api/v1/upstreams/route");
  upstreamRoute: typeof import("@/app/api/v1/upstreams/[id]/route");
  keysRoute: typeof import("@/app/api/v1/keys/route");
  keyRoute: typeof import("@/app/api/v1/keys/[id]/route");
  rotateRoute: typeof import("@/app/api/v1/keys/[id]/rotate/route");
  revokeRoute: typeof import("@/app/api/v1/keys/[id]/revoke/route");
  duplicateRoute: typeof import("@/app/api/v1/keys/[id]/duplicate/route");
  deniesRoute: typeof import("@/app/api/v1/keys/[id]/denies/route");
  effectiveRoute: typeof import("@/app/api/v1/keys/[id]/effective/route");
  installRoute: typeof import("@/app/api/v1/keys/[id]/install.md/route");
  grantsRoute: typeof import("@/app/api/v1/grants/route");
  grantRoute: typeof import("@/app/api/v1/grants/[id]/route");
  matrixRoute: typeof import("@/app/api/v1/access-matrix/route");
  rolesRoute: typeof import("@/app/api/v1/roles/route");
  roleRoute: typeof import("@/app/api/v1/roles/[id]/route");
  roleKeysRoute: typeof import("@/app/api/v1/roles/[id]/keys/route");
  itemsRoute: typeof import("@/app/api/v1/upstreams/[id]/items/route");
  overrideRoute: typeof import("@/app/api/v1/upstreams/[id]/items/[kind]/[name]/route");
  accessRoute: typeof import("@/app/api/v1/upstreams/[id]/access/route");
  statusRoute: typeof import("@/app/api/v1/status/route");
  logsRoute: typeof import("@/app/api/v1/logs/route");
  settingsRoute: typeof import("@/app/api/v1/settings/route");
  exportRoute: typeof import("@/app/api/v1/export/route");
  oauthCallback: typeof import("@/app/oauth/callback/route");
  db: typeof import("@/lib/db");
  schema: typeof import("@/lib/db/schema");
  catalog: typeof import("@/lib/catalog/catalog");
  authKeys: typeof import("@/lib/auth/keys");
  events: typeof import("@/lib/events");
};

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-api-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_ADMIN_PASSWORD = "test-password";
  process.env.SWITCHBOARD_SECRET = "test-secret-that-is-long-enough-32";
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.SWITCHBOARD_PUBLIC_URL = "https://switchboard.test";

  mod = {
    guard: await import("@/lib/api/guard"),
    session: await import("@/app/api/v1/session/route"),
    upstreamsRoute: await import("@/app/api/v1/upstreams/route"),
    upstreamRoute: await import("@/app/api/v1/upstreams/[id]/route"),
    keysRoute: await import("@/app/api/v1/keys/route"),
    keyRoute: await import("@/app/api/v1/keys/[id]/route"),
    rotateRoute: await import("@/app/api/v1/keys/[id]/rotate/route"),
    revokeRoute: await import("@/app/api/v1/keys/[id]/revoke/route"),
    duplicateRoute: await import("@/app/api/v1/keys/[id]/duplicate/route"),
    deniesRoute: await import("@/app/api/v1/keys/[id]/denies/route"),
    effectiveRoute: await import("@/app/api/v1/keys/[id]/effective/route"),
    installRoute: await import("@/app/api/v1/keys/[id]/install.md/route"),
    grantsRoute: await import("@/app/api/v1/grants/route"),
    grantRoute: await import("@/app/api/v1/grants/[id]/route"),
    matrixRoute: await import("@/app/api/v1/access-matrix/route"),
    rolesRoute: await import("@/app/api/v1/roles/route"),
    roleRoute: await import("@/app/api/v1/roles/[id]/route"),
    roleKeysRoute: await import("@/app/api/v1/roles/[id]/keys/route"),
    itemsRoute: await import("@/app/api/v1/upstreams/[id]/items/route"),
    overrideRoute: await import("@/app/api/v1/upstreams/[id]/items/[kind]/[name]/route"),
    accessRoute: await import("@/app/api/v1/upstreams/[id]/access/route"),
    statusRoute: await import("@/app/api/v1/status/route"),
    logsRoute: await import("@/app/api/v1/logs/route"),
    settingsRoute: await import("@/app/api/v1/settings/route"),
    exportRoute: await import("@/app/api/v1/export/route"),
    oauthCallback: await import("@/app/oauth/callback/route"),
    db: await import("@/lib/db"),
    schema: await import("@/lib/db/schema"),
    catalog: await import("@/lib/catalog/catalog"),
    authKeys: await import("@/lib/auth/keys"),
    events: await import("@/lib/events"),
  };
});

afterAll(() => {
  mod?.db.closeDb();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function req(pathname: string, init?: RequestInit): Request {
  return new Request("http://localhost" + pathname, init);
}

function jsonInit(method: string, body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}

function idCtx<T extends Record<string, string>>(params: T) {
  return { params: Promise.resolve(params) };
}

let adminKey = "";
let agentKey = "";

async function bodyOf(response: Response): Promise<any> {
  return JSON.parse(await response.text());
}

beforeEach(() => {
  // One admin key + one agent key reused across tests; created lazily.
  if (!adminKey) {
    adminKey = mod.authKeys.createKey({ name: "test-admin", scope: "admin" }).secret;
  }
  if (!agentKey) {
    agentKey = mod.authKeys.createKey({ name: "test-agent", scope: "agent" }).secret;
  }
});

const ADMIN = () => ({ authorization: `Bearer ${adminKey}` });

describe("lib/api/guard", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await mod.upstreamsRoute.GET(req("/api/v1/upstreams"));
    expect(res.status).toBe(401);
    expect((await bodyOf(res)).error).toBeTruthy();
  });

  it("rejects an agent-scope key with 403", async () => {
    const res = await mod.upstreamsRoute.GET(req("/api/v1/upstreams", { headers: { authorization: `Bearer ${agentKey}` } }));
    expect(res.status).toBe(403);
    expect((await bodyOf(res)).error).toMatch(/admin/i);
  });

  it("accepts an admin-scope key", async () => {
    const guard = await mod.guard.requireAdmin(req("/x", { headers: ADMIN() }));
    expect(guard.ok).toBe(true);
    if (guard.ok) expect(guard.actor).toBe("key:test-admin");
  });

  it("rejects an unknown bearer secret with 401", async () => {
    const guard = await mod.guard.requireAdmin(req("/x", { headers: { authorization: "Bearer sk-sw-nope" } }));
    expect(guard.ok).toBe(false);
    if (!guard.ok) expect(guard.status).toBe(401);
  });

  it("accepts the UI session cookie", async () => {
    const login = await mod.session.POST(req("/api/v1/session", jsonInit("POST", { password: "test-password" })));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("sb_admin=");
    const token = cookie.split(";")[0];

    const guard = await mod.guard.requireAdmin(req("/x", { headers: { cookie: token } }));
    expect(guard.ok).toBe(true);
    if (guard.ok) expect(guard.actor).toBe("ui");

    const list = await mod.upstreamsRoute.GET(req("/api/v1/upstreams", { headers: { cookie: token } }));
    expect(list.status).toBe(200);
  });

  it("rejects a bad password", async () => {
    const res = await mod.session.POST(req("/api/v1/session", jsonInit("POST", { password: "wrong" })));
    expect(res.status).toBe(401);
  });

  it("parses bodies and reports validation issues", async () => {
    const res = await mod.upstreamsRoute.POST(req("/api/v1/upstreams", jsonInit("POST", { name: "x", transport: "ftp" }, ADMIN())));
    expect(res.status).toBe(400);
    const body = await bodyOf(res);
    expect(Array.isArray(body.details)).toBe(true);
  });
});

describe("upstreams CRUD", () => {
  let upstreamId = "";

  it("creates an upstream and never returns secrets", async () => {
    const res = await mod.upstreamsRoute.POST(
      req(
        "/api/v1/upstreams",
        jsonInit(
          "POST",
          {
            name: "Toto Tools",
            slug: "toto",
            transport: "http",
            url: "https://toto.test/mcp",
            authType: "headers",
            headers: { "X-API-Key": "super-secret-value" },
            env: { SECRET_ENV: "other-secret" },
            access: { subjects: [{ subjectType: "role", subjectId: "nobody", toolMode: "all" }] },
          },
          ADMIN(),
        ),
      ),
    );
    expect(res.status).toBe(201);
    const body = await bodyOf(res);
    upstreamId = body.upstream.id;
    expect(body.upstream.slug).toBe("toto");
    expect(body.upstream.hasHeaders).toBe(true);
    expect(body.upstream.headerKeys).toEqual(["X-API-Key"]);
    expect(body.upstream.hasEnv).toBe(true);
    // No secret material anywhere in the serialized payload.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("super-secret-value");
    expect(raw).not.toContain("other-secret");
    expect(body.grants).toBe(1);
  });

  it("lists upstreams with derived counts", async () => {
    const res = await mod.upstreamsRoute.GET(req("/api/v1/upstreams", { headers: ADMIN() }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const found = body.items.find((u: any) => u.id === upstreamId);
    expect(found).toBeTruthy();
    expect(found.counts).toMatchObject({ tools: 0, prompts: 0, keyCount: 0 });
    expect(found.counts).toHaveProperty("p50Ms");
  });

  it("derives a unique slug when the requested one is taken", async () => {
    const res = await mod.upstreamsRoute.POST(
      req("/api/v1/upstreams", jsonInit("POST", { name: "Toto 2", slug: "toto", transport: "stdio", command: "npx", args: ["-y", "x"] }, ADMIN())),
    );
    expect(res.status).toBe(201);
    const body = await bodyOf(res);
    expect(body.upstream.slug).not.toBe("toto");
    expect(body.upstream.slug).toMatch(/^[a-z0-9]{1,12}$/);
  });

  it("rotates only the bearer token without losing other headers", async () => {
    const created = await bodyOf(
      await mod.upstreamsRoute.POST(
        req("/api/v1/upstreams", jsonInit("POST", { name: "Bearer MCP", slug: "bearer", transport: "http", url: "https://b.test/mcp", authType: "bearer", headers: { "X-Org": "acme" }, bearerToken: "tok-one" }, ADMIN())),
      ),
    );
    expect(created.upstream.headerKeys).toEqual(["Authorization", "X-Org"]);

    const patched = await bodyOf(
      await mod.upstreamRoute.PATCH(
        req(`/api/v1/upstreams/${created.upstream.id}`, jsonInit("PATCH", { bearerToken: "tok-two" }, ADMIN())),
        idCtx({ id: created.upstream.id }),
      ),
    );
    // Other headers survive a token-only rotation, and no secret leaks.
    expect(patched.upstream.headerKeys).toEqual(["Authorization", "X-Org"]);
    expect(patched.upstream.authType).toBe("bearer");
    expect(JSON.stringify(patched)).not.toContain("tok-two");

    const { decodeSecretMap } = await import("@/lib/api/secrets");
    const stored = mod.db.getDb().select().from(mod.schema.upstreams).all().find((u: any) => u.id === created.upstream.id)!;
    expect(decodeSecretMap(stored.headersEnc)).toEqual({ "X-Org": "acme", Authorization: "Bearer tok-two" });
  });

  it("requires a command for stdio and a url for http", async () => {
    const noCommand = await mod.upstreamsRoute.POST(
      req("/api/v1/upstreams", jsonInit("POST", { name: "no cmd", transport: "stdio" }, ADMIN())),
    );
    expect(noCommand.status).toBe(400);
    const noUrl = await mod.upstreamsRoute.POST(
      req("/api/v1/upstreams", jsonInit("POST", { name: "no url", transport: "http" }, ADMIN())),
    );
    expect(noUrl.status).toBe(400);
  });

  it("restart/test-console/oauth routes report 503 without a manager and 404 for unknown ids", async () => {
    const restartRoute = await import("@/app/api/v1/upstreams/[id]/restart/route");
    const consoleRoute = await import("@/app/api/v1/upstreams/[id]/test/route");
    const oauthRoute = await import("@/app/api/v1/upstreams/[id]/oauth/start/route");
    const stderrRoute = await import("@/app/api/v1/upstreams/[id]/stderr/route");

    // Unknown upstream -> 404 everywhere.
    const missing = "00000000-0000-0000-0000-000000000000";
    expect((await restartRoute.POST(req("/r", { method: "POST", headers: ADMIN() }), idCtx({ id: missing }))).status).toBe(404);
    expect((await consoleRoute.POST(req("/t", jsonInit("POST", { tool: "x" }, ADMIN())), idCtx({ id: missing }))).status).toBe(404);
    expect((await oauthRoute.POST(req("/o", { method: "POST", headers: ADMIN() }), idCtx({ id: missing }))).status).toBe(404);
    expect((await stderrRoute.GET(req("/s", { headers: ADMIN() }), idCtx({ id: missing }))).status).toBe(404);

    // Known upstream but no manager in tests -> 503 for the runtime-dependent routes.
    expect((await restartRoute.POST(req("/r", { method: "POST", headers: ADMIN() }), idCtx({ id: upstreamId }))).status).toBe(503);
    expect((await consoleRoute.POST(req("/t", jsonInit("POST", { tool: "x" }, ADMIN())), idCtx({ id: upstreamId }))).status).toBe(503);

    // oauth/start rejects non-OAuth upstreams with 400 before touching the manager.
    const oauthWrong = await oauthRoute.POST(req("/o", { method: "POST", headers: ADMIN() }), idCtx({ id: upstreamId }));
    expect(oauthWrong.status).toBe(400);

    // stderr degrades gracefully to an empty ring.
    const stderr = await stderrRoute.GET(req("/s", { headers: ADMIN() }), idCtx({ id: upstreamId }));
    expect(stderr.status).toBe(200);
    const stderrBody = await bodyOf(stderr);
    expect(stderrBody.lines).toEqual([]);
    expect(stderrBody.stderr).toEqual([]);
    expect(stderrBody.runtime).toBe(false);
  });

  it("reads, patches and deletes one upstream", async () => {
    const get = await mod.upstreamRoute.GET(req(`/api/v1/upstreams/${upstreamId}`, { headers: ADMIN() }), idCtx({ id: upstreamId }));
    expect(get.status).toBe(200);
    const detail = await bodyOf(get);
    expect(detail.upstream.id).toBe(upstreamId);
    expect(Array.isArray(detail.grants)).toBe(true);

    const patch = await mod.upstreamRoute.PATCH(
      req(`/api/v1/upstreams/${upstreamId}`, jsonInit("PATCH", { name: "Toto Renamed", enabled: false }, ADMIN())),
      idCtx({ id: upstreamId }),
    );
    expect(patch.status).toBe(200);
    const patched = await bodyOf(patch);
    expect(patched.upstream.name).toBe("Toto Renamed");
    expect(patched.upstream.enabled).toBe(false);
    expect(patched.upstream.status).toBe("disabled");
    // Secrets untouched when not supplied.
    expect(patched.upstream.hasHeaders).toBe(true);

    const del = await mod.upstreamRoute.DELETE(req(`/api/v1/upstreams/${upstreamId}`, { method: "DELETE", headers: ADMIN() }), idCtx({ id: upstreamId }));
    expect(del.status).toBe(200);
    const after = await mod.upstreamRoute.GET(req(`/api/v1/upstreams/${upstreamId}`, { headers: ADMIN() }), idCtx({ id: upstreamId }));
    expect(after.status).toBe(404);
  });
});

describe("keys", () => {
  let keyId = "";
  let secret = "";
  let upstreamId = "";

  beforeAll(async () => {
    // A ready upstream with two tools, so grants have something to expose.
    const created = await mod.upstreamsRoute.POST(
      req("/api/v1/upstreams", jsonInit("POST", { name: "GitHub", slug: "gh", transport: "http", url: "https://gh.test/mcp" }, ADMIN())),
    );
    const body = await bodyOf(created);
    upstreamId = body.upstream.id;
    const db = mod.db.getDb();
    db.update(mod.schema.upstreams).set({ status: "ready" }).run?.();
    // Drizzle update requires a where clause; use raw SQL for the test fixture.
    mod.db.getDbHandle().sqlite.prepare("UPDATE upstreams SET status = 'ready' WHERE id = ?").run(upstreamId);
    mod.db
      .getDb()
      .insert(mod.schema.upstreamItems)
      .values([
        { upstreamId, kind: "tool", name: "create_issue", definition: { name: "create_issue", description: "Create an issue" }, fetchedAt: Date.now() },
        { upstreamId, kind: "tool", name: "list_issues", definition: { name: "list_issues", description: "List issues" }, fetchedAt: Date.now() },
      ])
      .run();
    mod.catalog.getCatalog().forceNotify("test-fixture");
  });

  it("creates a key and returns the secret exactly once", async () => {
    const res = await mod.keysRoute.POST(
      req("/api/v1/keys", jsonInit("POST", { name: "claude-laptop", exposureMode: "direct", roleIds: [] }, ADMIN())),
    );
    expect(res.status).toBe(201);
    const body = await bodyOf(res);
    expect(body.secret).toMatch(/^sk-sw-[A-Za-z0-9]{32}$/);
    expect(body.key.prefix).toBe(body.secret.slice(0, 12));
    expect(JSON.stringify(body.key)).not.toContain(body.secret);
    keyId = body.key.id;
    secret = body.secret;
  });

  it("rejects a duplicate key name with 409", async () => {
    const res = await mod.keysRoute.POST(req("/api/v1/keys", jsonInit("POST", { name: "claude-laptop" }, ADMIN())));
    expect(res.status).toBe(409);
  });

  it("lists and reads a key without leaking the hash", async () => {
    const list = await mod.keysRoute.GET(req("/api/v1/keys", { headers: ADMIN() }));
    const body = await bodyOf(list);
    const found = body.items.find((k: any) => k.id === keyId);
    expect(found.status).toBe("active");
    expect(found.counts).toHaveProperty("tools");
    expect(found.calls).toHaveProperty("denied24h");
    expect(JSON.stringify(body)).not.toContain(secret);

    const detail = await mod.keyRoute.GET(req(`/api/v1/keys/${keyId}`, { headers: ADMIN() }), idCtx({ id: keyId }));
    const detailBody = await bodyOf(detail);
    expect(detailBody.key.id).toBe(keyId);
    expect(detailBody.effective.keyId).toBe(keyId);
    expect(Array.isArray(detailBody.ownGrants)).toBe(true);
  });

  it("patches a key", async () => {
    const res = await mod.keyRoute.PATCH(
      req(`/api/v1/keys/${keyId}`, jsonInit("PATCH", { description: "my laptop", exposureMode: "discovery" }, ADMIN())),
      idCtx({ id: keyId }),
    );
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.key.description).toBe("my laptop");
    expect(body.key.exposureMode).toBe("discovery");
  });

  it("upserts a grant and reflects it in the effective view", async () => {
    const res = await mod.grantsRoute.PUT(
      req(
        "/api/v1/grants",
        jsonInit("PUT", { subjectType: "key", subjectId: keyId, upstreamId, toolMode: "selected", tools: ["create_issue"], prompts: true, resources: false }, ADMIN()),
      ),
    );
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.grant.toolMode).toBe("selected");
    expect(body.grant.tools).toEqual(["create_issue"]);
    expect(body.effective.upstreams[0].tools.map((t: any) => t.name)).toEqual(["create_issue"]);
    expect(body.effective.upstreams[0].tools[0].publicName).toBe("gh__create_issue");

    // Upsert is idempotent on (subject, upstream).
    const again = await mod.grantsRoute.PUT(
      req("/api/v1/grants", jsonInit("PUT", { subjectType: "key", subjectId: keyId, upstreamId, toolMode: "all" }, ADMIN())),
    );
    const againBody = await bodyOf(again);
    expect(againBody.grant.id).toBe(body.grant.id);
    expect(againBody.effective.publicTools).toContain("gh__list_issues");
  });

  it("rejects a grant for an unknown subject", async () => {
    const res = await mod.grantsRoute.PUT(
      req("/api/v1/grants", jsonInit("PUT", { subjectType: "key", subjectId: "nope", upstreamId, toolMode: "all" }, ADMIN())),
    );
    expect(res.status).toBe(400);
  });

  it("exposes the effective preview endpoint", async () => {
    const res = await mod.effectiveRoute.GET(req(`/api/v1/keys/${keyId}/effective`, { headers: ADMIN() }), idCtx({ id: keyId }));
    const body = await bodyOf(res);
    expect(body.effective.totals.tools).toBe(2);
    expect(body.effective.totals.estimatedTokens).toBeGreaterThan(0);
    expect(body.upstreamSlugById[upstreamId]).toBe("gh");
  });

  it("applies key-level denies on top of grants", async () => {
    const res = await mod.deniesRoute.PUT(
      req(`/api/v1/keys/${keyId}/denies`, jsonInit("PUT", { denies: [{ upstreamId, toolName: "list_issues" }] }, ADMIN())),
      idCtx({ id: keyId }),
    );
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.denies).toEqual([{ upstreamId, toolName: "list_issues" }]);
    expect(body.effective.upstreams[0].tools.map((t: any) => t.name)).toEqual(["create_issue"]);
  });

  it("serves install.md as markdown without the secret", async () => {
    const res = await mod.installRoute.GET(req(`/api/v1/keys/${keyId}/install.md`, { headers: ADMIN() }), idCtx({ id: keyId }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    // Inline by default (the UI opens it in a tab); attachment only when asked.
    expect(res.headers.get("content-disposition")).toBeNull();

    const dl = await mod.installRoute.GET(
      req(`/api/v1/keys/${keyId}/install.md?download=1`, { headers: ADMIN() }),
      idCtx({ id: keyId }),
    );
    expect(dl.headers.get("content-disposition")).toContain("INSTALL-claude-laptop.md");
    const text = await res.text();
    expect(text).toContain("# INSTALL-claude-laptop.md");
    expect(text).toContain("https://switchboard.test/mcp");
    expect(text).toContain("claude mcp add");
    expect(text).toContain("bearer_token_env_var");
    expect(text).toContain("gh__create_issue");
    // The secret is only shown once; install.md must not contain it.
    expect(text).not.toContain(secret);
  });

  it("rotates the secret with a grace window", async () => {
    const res = await mod.rotateRoute.POST(
      req(`/api/v1/keys/${keyId}/rotate`, jsonInit("POST", { graceSeconds: 3600 }, ADMIN())),
      idCtx({ id: keyId }),
    );
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    const newSecret = body.secret as string;
    expect(newSecret).toMatch(/^sk-sw-/);
    expect(newSecret).not.toBe(secret);

    const auth = await import("@/lib/auth/keys");
    const newAuth = auth.authenticateSecret(newSecret);
    expect(newAuth.ok).toBe(true);

    // Old secret still valid during the grace window, marked as "previous".
    const oldAuth = auth.authenticateSecret(secret);
    expect(oldAuth.ok).toBe(true);
    if (oldAuth.ok) expect(oldAuth.via).toBe("previous");
    secret = newSecret;
  });

  it("rotates with grace 0 and invalidates the old secret immediately", async () => {
    const res = await mod.rotateRoute.POST(
      req(`/api/v1/keys/${keyId}/rotate`, jsonInit("POST", { graceSeconds: 0 }, ADMIN())),
      idCtx({ id: keyId }),
    );
    const body = await bodyOf(res);
    const auth = await import("@/lib/auth/keys");
    expect(auth.authenticateSecret(secret).ok).toBe(false);
    expect(auth.authenticateSecret(body.secret).ok).toBe(true);
    secret = body.secret;
  });

  it("supports the 3-step wizard: ?include=install returns snippets + grants in one call", async () => {
    const res = await mod.keysRoute.POST(
      req(
        "/api/v1/keys?include=install",
        jsonInit(
          "POST",
          {
            name: "wizard-key",
            exposureMode: "direct",
            grants: [{ upstreamId, toolMode: "selected", tools: ["create_issue"], prompts: false, resources: false }],
          },
          ADMIN(),
        ),
      ),
    );
    expect(res.status).toBe(201);
    const body = await bodyOf(res);
    expect(body.secret).toMatch(/^sk-sw-/);
    expect(body.key.id).toBeTruthy();
    // InstallPayload shape the wizard renders.
    expect(body.install.url).toContain("/mcp");
    expect(body.install.keyName).toBe("wizard-key");
    expect(body.install.markdown).toContain("# INSTALL-wizard-key.md");
    expect(body.install.claudeCodeCommand).toContain("claude mcp add");
    expect(body.install.codexConfig).toContain("bearer_token_env_var");
    expect(body.install.json).toContain("mcpServers");
    expect(Array.isArray(body.install.allowed)).toBe(true);
    // The granted tool is listed for the agent...
    expect(body.install.allowed[0].tools).toEqual(["gh__create_issue"]);
    // ...and the secret is only in the top-level field, never inside install.markdown/json payloads
    // beyond the placeholder.
    expect(body.install.markdown).not.toContain(body.secret);
    expect(body.key.counts.tools).toBe(1);
  });

  it("copies rights from another key with copyFromKeyId (spec §7.1)", async () => {
    const source = mod.authKeys.createKey({ name: "copy-source" });
    const role = await bodyOf(await mod.rolesRoute.POST(req("/api/v1/roles", jsonInit("POST", { name: "copy-role" }, ADMIN()))));
    mod.authKeys.updateKey(source.id, { roleIds: [role.role.id] });
    await mod.grantsRoute.PUT(
      req("/api/v1/grants", jsonInit("PUT", { subjectType: "key", subjectId: source.id, upstreamId, toolMode: "selected", tools: ["list_issues"] }, ADMIN())),
    );

    const res = await mod.keysRoute.POST(
      req("/api/v1/keys", jsonInit("POST", { name: "copy-target", copyFromKeyId: source.id }, ADMIN())),
    );
    expect(res.status).toBe(201);
    const body = await bodyOf(res);
    const grants = await import("@/lib/auth/grants");
    const copied = grants.grantFor("key", body.key.id, upstreamId);
    expect(copied?.toolMode).toBe("selected");
    expect(copied?.tools).toEqual(["list_issues"]);
    expect(mod.authKeys.roleIdsForKey(body.key.id)).toEqual([role.role.id]);
  });

  it("duplicates a key with its roles and grants", async () => {
    const res = await mod.duplicateRoute.POST(
      req(`/api/v1/keys/${keyId}/duplicate`, jsonInit("POST", { name: "claude-laptop-2" }, ADMIN())),
      idCtx({ id: keyId }),
    );
    expect(res.status).toBe(201);
    const body = await bodyOf(res);
    expect(body.secret).toMatch(/^sk-sw-/);
    expect(body.key.name).toBe("claude-laptop-2");
    expect(body.key.counts.tools).toBe(1);

    const grants = await import("@/lib/auth/grants");
    const own = grants.grantFor("key", body.key.id, upstreamId);
    expect(own?.toolMode).toBe("all");
  });

  it("revokes a key", async () => {
    const res = await mod.revokeRoute.POST(req(`/api/v1/keys/${keyId}/revoke`, { method: "POST", headers: ADMIN() }), idCtx({ id: keyId }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.revoked).toBe(true);
    expect(body.key.status).toBe("revoked");

    const auth = await import("@/lib/auth/keys");
    expect(auth.authenticateSecret(secret).ok).toBe(false);
  });
});

describe("roles", () => {
  it("creates, reads, updates and deletes a role, and sets its keys", async () => {
    const created = await mod.rolesRoute.POST(req("/api/v1/roles", jsonInit("POST", { name: "dev-wegrow", description: "dev" }, ADMIN())));
    expect(created.status).toBe(201);
    const role = (await bodyOf(created)).role;

    const list = await mod.rolesRoute.GET(req("/api/v1/roles", { headers: ADMIN() }));
    const listBody = await bodyOf(list);
    expect(listBody.items.some((r: any) => r.id === role.id && r.upstreamCount === 0)).toBe(true);

    const key = mod.authKeys.createKey({ name: "role-key" });
    const putKeys = await mod.roleKeysRoute.PUT(
      req(`/api/v1/roles/${role.id}/keys`, jsonInit("PUT", { keyIds: [key.id] }, ADMIN())),
      idCtx({ id: role.id }),
    );
    expect(putKeys.status).toBe(200);
    expect(mod.authKeys.roleIdsForKey(key.id)).toEqual([role.id]);

    const detail = await mod.roleRoute.GET(req(`/api/v1/roles/${role.id}`, { headers: ADMIN() }), idCtx({ id: role.id }));
    const detailBody = await bodyOf(detail);
    expect(detailBody.role.keyIds).toEqual([key.id]);

    const dup = await mod.rolesRoute.POST(req("/api/v1/roles", jsonInit("POST", { name: "dev-wegrow" }, ADMIN())));
    expect(dup.status).toBe(409);

    const del = await mod.roleRoute.DELETE(req(`/api/v1/roles/${role.id}`, { method: "DELETE", headers: ADMIN() }), idCtx({ id: role.id }));
    expect(del.status).toBe(200);
    expect(mod.authKeys.roleIdsForKey(key.id)).toEqual([]);
  });
});

describe("access-matrix", () => {
  it("returns rows per key and role with cell kinds", async () => {
    const res = await mod.matrixRoute.GET(req("/api/v1/access-matrix", { headers: ADMIN() }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(Array.isArray(body.upstreams)).toBe(true);
    const keyRow = body.rows.find((r: any) => r.subjectType === "key" && r.label === "claude-laptop-2");
    expect(keyRow).toBeTruthy();
    const cell = Object.values(keyRow.cells)[0] as any;
    expect(["all", "selected", "none", "denied"]).toContain(cell.kind);
    expect(body.legend.all).toBe("●");
  });

  it("attaches grantId to cells so the rights editor can delete a grant", async () => {
    const key = mod.authKeys.createKey({ name: "matrix-editor-key" });
    const upstream = mod.db.getDb().select().from(mod.schema.upstreams).all()[0];
    const created = await bodyOf(
      await mod.grantsRoute.PUT(
        req("/api/v1/grants", jsonInit("PUT", { subjectType: "key", subjectId: key.id, upstreamId: upstream.id, toolMode: "selected", tools: ["create_issue"] }, ADMIN())),
      ),
    );

    const matrix = await bodyOf(await mod.matrixRoute.GET(req("/api/v1/access-matrix?subject=key", { headers: ADMIN() })));
    const row = matrix.rows.find((r: any) => r.subjectId === key.id);
    const cell = row.cells[upstream.id];
    expect(cell.kind).toBe("selected");
    expect(cell.grantId).toBe(created.grant.id);

    // A key with no grant has a null grantId (no 404, no crash).
    const noGrant = await bodyOf(await mod.matrixRoute.GET(req("/api/v1/access-matrix?subject=key", { headers: ADMIN() })));
    const emptyRow = noGrant.rows.find((r: any) => r.subjectId === "nobody");
    expect(emptyRow).toBeUndefined();

    // Single-row lookup, used by GET /keys/{id}/access.
    const single = await bodyOf(await mod.matrixRoute.GET(req(`/api/v1/access-matrix?subject=key&subjectId=${key.id}`, { headers: ADMIN() })));
    expect(single.row.subjectId).toBe(key.id);
    expect(single.row.cells[upstream.id].grantId).toBe(created.grant.id);

    // The key-scoped endpoint returns the same row shape.
    const keyAccessRoute = await import("@/app/api/v1/keys/[id]/access/route");
    const keyAccess = await bodyOf(
      await keyAccessRoute.GET(req(`/api/v1/keys/${key.id}/access`, { headers: ADMIN() }), idCtx({ id: key.id })),
    );
    expect(keyAccess.row.cells[upstream.id].grantId).toBe(created.grant.id);
    expect(keyAccess.effective.keyId).toBe(key.id);
  });

  it("exports CSV", async () => {
    const res = await mod.matrixRoute.GET(req("/api/v1/access-matrix?format=csv", { headers: ADMIN() }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const text = await res.text();
    expect(text.split("\n")[0]).toContain("subjectType");
  });
});

describe("upstream items and overrides", () => {
  let upstreamId = "";

  beforeAll(async () => {
    const created = await mod.upstreamsRoute.POST(
      req("/api/v1/upstreams", jsonInit("POST", { name: "Jira", slug: "jira", transport: "http", url: "https://jira.test/mcp" }, ADMIN())),
    );
    upstreamId = (await bodyOf(created)).upstream.id;
    mod.db
      .getDb()
      .insert(mod.schema.upstreamItems)
      .values({
        upstreamId,
        kind: "tool",
        name: "search issues",
        definition: { name: "search issues", description: "Search" },
        fetchedAt: Date.now(),
      })
      .run();
    mod.catalog.getCatalog().forceNotify("test-items");
  });

  it("lists items and their overrides", async () => {
    const res = await mod.itemsRoute.GET(req(`/api/v1/upstreams/${upstreamId}/items?kind=tool`, { headers: ADMIN() }), idCtx({ id: upstreamId }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].enabled).toBe(true);
    expect(body.items[0].publicName).toMatch(/^jira__/);
  });

  it("sets and resets a global override on a URL-encoded item name", async () => {
    const name = encodeURIComponent("search issues");
    const put = await mod.overrideRoute.PUT(
      req(`/api/v1/upstreams/${upstreamId}/items/tool/${name}`, jsonInit("PUT", { enabled: false, alias: "find_issues" }, ADMIN())),
      idCtx({ id: upstreamId, kind: "tool", name }),
    );
    expect(put.status).toBe(200);
    const body = await bodyOf(put);
    expect(body.item.name).toBe("search issues");
    expect(body.item.enabled).toBe(false);
    expect(body.item.alias).toBe("find_issues");

    const del = await mod.overrideRoute.DELETE(
      req(`/api/v1/upstreams/${upstreamId}/items/tool/${name}`, { method: "DELETE", headers: ADMIN() }),
      idCtx({ id: upstreamId, kind: "tool", name }),
    );
    expect(del.status).toBe(200);
    expect((await bodyOf(del)).reset).toBe(true);
  });

  it("404s on an unknown item and 400s on a bad kind", async () => {
    const missing = await mod.overrideRoute.PUT(
      req(`/api/v1/upstreams/${upstreamId}/items/tool/nope`, jsonInit("PUT", { enabled: false }, ADMIN())),
      idCtx({ id: upstreamId, kind: "tool", name: "nope" }),
    );
    expect(missing.status).toBe(404);
    const badKind = await mod.overrideRoute.PUT(
      req(`/api/v1/upstreams/${upstreamId}/items/bogus/x`, jsonInit("PUT", { enabled: false }, ADMIN())),
      idCtx({ id: upstreamId, kind: "bogus", name: "x" }),
    );
    expect(badKind.status).toBe(400);
  });

  it("returns who has access to an upstream", async () => {
    const res = await mod.accessRoute.GET(req(`/api/v1/upstreams/${upstreamId}/access`, { headers: ADMIN() }), idCtx({ id: upstreamId }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.upstream.id).toBe(upstreamId);
    expect(Array.isArray(body.keys)).toBe(true);
    expect(Array.isArray(body.grants)).toBe(true);
    expect(body.summary).toHaveProperty("keyCount");
  });
});

describe("status, logs, settings, export", () => {
  it("returns the dashboard payload", async () => {
    const res = await mod.statusRoute.GET(req("/api/v1/status", { headers: ADMIN() }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.upstreams.total).toBeGreaterThan(0);
    expect(body.upstreams.byStatus).toHaveProperty("ready");
    expect(body.keys.total).toBeGreaterThan(0);
    expect(body).toHaveProperty("calls24h");
    expect(body.feedback.unreadBySeverity).toHaveProperty("blocking");
    expect(Array.isArray(body.oauthRequired)).toBe(true);
    expect(body.discoveries).toHaveProperty("unacknowledged");
    expect(body.catalog).toHaveProperty("version");
  });

  it("filters the call log", async () => {
    const key = mod.authKeys.createKey({ name: "log-key" });
    const upstream = mod.db.getDb().select().from(mod.schema.upstreams).all()[0];
    mod.db.getDb().insert(mod.schema.callLogs).values({
      id: "call-1",
      at: Date.now(),
      keyId: key.id,
      upstreamId: upstream.id,
      kind: "tool",
      name: "gh__create_issue",
      ok: false,
      denied: true,
      errorCode: "denied",
      durationMs: 12,
    }).run();

    const res = await mod.logsRoute.GET(req(`/api/v1/logs?key=${key.id}&denied=true`, { headers: ADMIN() }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].keyName).toBe("log-key");
    expect(body.items[0].upstreamSlug).toBe(upstream.slug);
    expect(body.total).toBe(1);

    const none = await mod.logsRoute.GET(req(`/api/v1/logs?key=${key.id}&ok=true`, { headers: ADMIN() }));
    expect((await bodyOf(none)).items).toHaveLength(0);
  });

  it("reads and patches settings", async () => {
    const get = await mod.settingsRoute.GET(req("/api/v1/settings", { headers: ADMIN() }));
    const getBody = await bodyOf(get);
    expect(getBody.settings).toHaveProperty("discoveryThreshold");
    expect(getBody.masterKey.present).toBe(true);
    expect(JSON.stringify(getBody)).not.toContain(process.env.SWITCHBOARD_MASTER_KEY!);

    const patch = await mod.settingsRoute.PATCH(
      req("/api/v1/settings", jsonInit("PATCH", { discoveryThreshold: 42, publicUrl: "https://sb.example" }, ADMIN())),
    );
    expect(patch.status).toBe(200);
    expect((await bodyOf(patch)).settings.discoveryThreshold).toBe(42);

    const invalid = await mod.settingsRoute.PATCH(req("/api/v1/settings", jsonInit("PATCH", { discoveryThreshold: -1 }, ADMIN())));
    expect(invalid.status).toBe(400);
  });

  it("exports the client config for a key using a placeholder secret", async () => {
    const key = mod.authKeys.createKey({ name: "export-key" });
    const res = await mod.exportRoute.GET(req(`/api/v1/export?key=${key.id}`, { headers: ADMIN() }));
    expect(res.status).toBe(200);
    const body = await bodyOf(res);
    expect(body.url).toContain("/mcp");
    // Shapes the key detail page reads: mcpUrl + snippets{claudeCodeCommand,codexToml,mcpJson}.
    expect(body.mcpUrl).toBe(body.url);
    expect(body.snippets.claudeCodeCommand).toContain("claude mcp add");
    expect(body.snippets.codexToml).toContain("bearer_token_env_var");
    expect(body.snippets.mcpJson).toContain("mcpServers");
    expect(JSON.stringify(body.config)).toContain("Authorization");
    expect(JSON.stringify(body)).not.toContain(key.secret);
    expect(body.note).toMatch(/once/i);

    const missing = await mod.exportRoute.GET(req("/api/v1/export", { headers: ADMIN() }));
    expect(missing.status).toBe(400);
  });
});

describe("status session provider", () => {
  it("reports an empty session list when no provider is registered", async () => {
    const res = await mod.statusRoute.GET(req("/api/v1/status", { headers: ADMIN() }));
    const body = await bodyOf(res);
    expect(body.sessions).toEqual([]);
    expect(body.openSessions).toEqual([]);
    expect(body.gateway.sessions).toBe(0);
  });

  it("exposes sessions registered by the gateway, and per-key counts", async () => {
    const hooks = await import("@/lib/api/status-hooks");
    const key = mod.authKeys.createKey({ name: "session-key" });
    hooks.registerSessionProvider(() => [
      { id: "s1", keyId: key.id, keyName: key.name, clientName: "claude-code", since: Date.now() },
      { id: "s2", keyId: key.id, keyName: key.name, clientName: "codex", since: Date.now() },
    ]);

    try {
      const status = await bodyOf(await mod.statusRoute.GET(req("/api/v1/status", { headers: ADMIN() })));
      expect(status.openSessions).toHaveLength(2);
      expect(status.gateway.sessions).toBe(2);

      const detail = await bodyOf(
        await mod.keyRoute.GET(req(`/api/v1/keys/${key.id}`, { headers: ADMIN() }), idCtx({ id: key.id })),
      );
      expect(detail.key.sessions).toHaveLength(2);
      expect(detail.key.sessions[0].clientName).toBeTruthy();
    } finally {
      hooks.registerSessionProvider(null);
    }
  });

  it("degrades to an empty list when the provider throws", async () => {
    const hooks = await import("@/lib/api/status-hooks");
    hooks.registerSessionProvider(() => {
      throw new Error("gateway exploded");
    });
    try {
      const status = await bodyOf(await mod.statusRoute.GET(req("/api/v1/status", { headers: ADMIN() })));
      expect(status.openSessions).toEqual([]);
    } finally {
      hooks.registerSessionProvider(null);
    }
  });
});

describe("404s and method guards", () => {
  it("returns 404 for unknown ids on every single-resource route", async () => {
    const missing = "00000000-0000-0000-0000-000000000000";
    const checks = await Promise.all([
      mod.upstreamRoute.GET(req(`/api/v1/upstreams/${missing}`, { headers: ADMIN() }), idCtx({ id: missing })),
      mod.keyRoute.GET(req(`/api/v1/keys/${missing}`, { headers: ADMIN() }), idCtx({ id: missing })),
      mod.effectiveRoute.GET(req(`/api/v1/keys/${missing}/effective`, { headers: ADMIN() }), idCtx({ id: missing })),
      mod.installRoute.GET(req(`/api/v1/keys/${missing}/install.md`, { headers: ADMIN() }), idCtx({ id: missing })),
      mod.roleRoute.GET(req(`/api/v1/roles/${missing}`, { headers: ADMIN() }), idCtx({ id: missing })),
      mod.grantRoute.GET(req(`/api/v1/grants/${missing}`, { headers: ADMIN() }), idCtx({ id: missing })),
      mod.accessRoute.GET(req(`/api/v1/upstreams/${missing}/access`, { headers: ADMIN() }), idCtx({ id: missing })),
      mod.itemsRoute.GET(req(`/api/v1/upstreams/${missing}/items`, { headers: ADMIN() }), idCtx({ id: missing })),
    ]);
    for (const res of checks) expect(res.status).toBe(404);
  });

  it("requires admin auth on every route that mutates state", async () => {
    const res = await mod.keysRoute.POST(req("/api/v1/keys", jsonInit("POST", { name: "nope" })));
    expect(res.status).toBe(401);
    const deleteRes = await mod.upstreamRoute.DELETE(req("/api/v1/upstreams/x", { method: "DELETE" }), idCtx({ id: "x" }));
    expect(deleteRes.status).toBe(401);
    const revoke = await mod.revokeRoute.POST(req("/api/v1/keys/x/revoke", { method: "POST" }), idCtx({ id: "x" }));
    expect(revoke.status).toBe(401);
  });

  it("deletes a grant", async () => {
    const key = mod.authKeys.createKey({ name: "grant-del-key" });
    const upstream = mod.db.getDb().select().from(mod.schema.upstreams).all()[0];
    const created = await bodyOf(
      await mod.grantsRoute.PUT(
        req("/api/v1/grants", jsonInit("PUT", { subjectType: "key", subjectId: key.id, upstreamId: upstream.id, toolMode: "all" }, ADMIN())),
      ),
    );
    const del = await mod.grantRoute.DELETE(
      req(`/api/v1/grants/${created.grant.id}`, { method: "DELETE", headers: ADMIN() }),
      idCtx({ id: created.grant.id }),
    );
    expect(del.status).toBe(200);
    expect((await bodyOf(del)).deleted).toBe(true);
    const again = await mod.grantRoute.GET(
      req(`/api/v1/grants/${created.grant.id}`, { headers: ADMIN() }),
      idCtx({ id: created.grant.id }),
    );
    expect(again.status).toBe(404);
  });
});

describe("oauth callback", () => {
  it("redirects with an error when the state is unknown", async () => {
    const res = await mod.oauthCallback.GET(req("/oauth/callback?code=abc&state=unknown"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/servers?oauth=error");
  });

  it("redirects with an error when no state is provided", async () => {
    const res = await mod.oauthCallback.GET(req("/oauth/callback?code=abc"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("missing_state");
  });

  it("finds the upstream from oauth_states and redirects to its server page", async () => {
    const created = await mod.upstreamsRoute.POST(
      req(
        "/api/v1/upstreams",
        jsonInit("POST", { name: "OAuth MCP", slug: "oauthmcp", transport: "http", url: "https://oauth.test/mcp", authType: "oauth" }, ADMIN()),
      ),
    );
    const upstreamId = (await bodyOf(created)).upstream.id;
    mod.db.getDb().insert(mod.schema.oauthStates).values({
      state: "state-123",
      upstreamId,
      codeVerifier: "verifier",
      redirectUri: "https://switchboard.test/oauth/callback",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }).run();

    // No UpstreamManager in tests -> manager_unavailable, but the upstream is resolved from the state.
    const res = await mod.oauthCallback.GET(req("/oauth/callback?code=xyz&state=state-123"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`/servers/${upstreamId}?oauth=error`);
    expect(res.headers.get("location")).toContain("manager_unavailable");
  });

  it("rejects an expired state", async () => {
    mod.db.getDb().insert(mod.schema.oauthStates).values({
      state: "state-expired",
      upstreamId: "whatever",
      codeVerifier: "v",
      redirectUri: "https://switchboard.test/oauth/callback",
      createdAt: Date.now() - 100_000,
      expiresAt: Date.now() - 1000,
    }).run();
    const res = await mod.oauthCallback.GET(req("/oauth/callback?code=xyz&state=state-expired"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("reason=expired");
  });
});
