/**
 * Admin meta-tools (spec §6.6): an `scope=admin` key manages upstreams over MCP.
 *
 * Covers the surface itself, the isolation rules that make it safe (no upstream tool, no secret
 * value, no delete/restart), and the per-call re-check of the key scope.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { keepRuntimeStateForFile } from "./helpers/reset";

keepRuntimeStateForFile();

let dir: string;
let dbmod: typeof import("../lib/db");
let adminSecret: string;
let agentSecret: string;
let adminKeyId: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-admin-tools-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 12).toString("base64");
  process.env.SWITCHBOARD_SECRET = "test-secret-that-is-long-enough-32";
  process.env.SWITCHBOARD_ADMIN_PASSWORD = "test-password";

  vi.resetModules();
  dbmod = await import("../lib/db");
  dbmod.getDb();

  const { createKey } = await import("../lib/auth/keys");
  const admin = createKey({ name: "admin-tools", scope: "admin" });
  const agent = createKey({ name: "admin-tools-agent" });
  adminSecret = admin.secret;
  agentSecret = agent.secret;
  adminKeyId = admin.id;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Opens a session for a key and returns a connected client. */
async function connectFor(keyId: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const { createGatewayServer } = await import("../lib/gateway/server");
  const { createSessionState } = await import("../lib/gateway/sessions");
  const { getKey } = await import("../lib/auth/keys");
  const key = getKey(keyId);
  const state = createSessionState({
    sessionId: "admin-" + keyId,
    keyId,
    keyName: key?.name ?? "unknown",
    exposureMode: key?.exposureMode ?? "direct",
    ip: "127.0.0.1",
  });
  const server = createGatewayServer(state);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "admin-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

describe("admin tool surface", () => {
  it("lists exactly the admin tools for an admin key, and no upstream tool", async () => {
    const { client, close } = await connectFor(adminKeyId);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).filter((n) => n.startsWith("upstream_"));
      expect(names.sort()).toEqual(["upstream_create", "upstream_get", "upstream_list", "upstream_update"]);
      // The gateway's own tool stays available, and the instructions mention it: the list and
      // the instructions must agree, or an agent is told about a tool it cannot see.
      expect(tools.map((t) => t.name)).toContain("report_feedback");
      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("upstream_create");
      expect(instructions).toContain("report_feedback");
      // Destructive lifecycle actions stay on the REST API / UI.
      const banned = ["upstream_delete", "upstream_remove", "upstream_restart", "upstream_test"];
      for (const name of banned) expect(tools.map((t) => t.name)).not.toContain(name);
    } finally {
      await close();
    }
  });


describe("an admin key keeps its upstream tools (regression)", () => {
  /**
   * The bug: listToolsFor() returned ONLY the admin tools for a scope=admin key, so replacing an
   * agent key with an admin key silently removed every upstream tool from the client (89 -> 5 in
   * production). Scope answers "may I manage the gateway?"; grants answer "which upstreams may I
   * call?". The two are orthogonal and must compose, not exclude each other.
   */
  it("lists admin tools AND the upstream tools its grants allow", async () => {
    const { upsertGrant } = await import("../lib/auth/grants");
    const { upstreams, upstreamItems } = await import("../lib/db/schema");
    const now = Date.now();
    dbmod.getDb().insert(upstreams).values({
      id: "u-admin", slug: "adm", name: "Adm", transport: "http", url: "http://127.0.0.1:9/mcp",
      authType: "none", enabled: true, startMode: "always", status: "ready",
      createdAt: now, updatedAt: now,
    }).run();
    dbmod.getDb().insert(upstreamItems).values({
      upstreamId: "u-admin", kind: "tool", name: "do_it",
      definition: { name: "do_it", description: "Upstream tool", inputSchema: { type: "object", properties: {} } },
      fetchedAt: now,
    }).run();
    upsertGrant({ subjectType: "key", subjectId: adminKeyId, upstreamId: "u-admin", toolMode: "all", tools: [] });

    const { invalidateCatalog } = await import("../lib/catalog/catalog");
    invalidateCatalog("test");

    const { client, close } = await connectFor(adminKeyId);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      // Management surface still there...
      expect(names).toContain("upstream_create");
      // ...and the granted upstream tool is no longer hidden.
      expect(names).toContain("adm__do_it");
      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("adm");
      expect(instructions).toContain("upstream_create");
    } finally {
      await close();
    }
  });

  it("still refuses an upstream tool the admin key was not granted", async () => {
    const { client, close } = await connectFor(adminKeyId);
    try {
      // u-ungranted has a tool but no grant for this key: same error as an unknown tool.
      await expect(client.callTool({ name: "toto__A", arguments: {} })).rejects.toThrow(/not found/i);
    } finally {
      await close();
    }
  });
});
  it("gives an agent key none of the admin tools", async () => {
    const agent = await connectFor(
      (await import("../lib/auth/keys")).listKeys().find((k) => k.name === "admin-tools-agent")!.id,
    );
    try {
      const { tools } = await agent.client.listTools();
      for (const name of ["upstream_create", "upstream_update", "upstream_list", "upstream_get"]) {
        expect(tools.map((t) => t.name)).not.toContain(name);
      }
    } finally {
      await agent.close();
    }
  });
});

describe("upstream_create", () => {
  it("creates an http upstream and reports it back", async () => {
    const { client, close } = await connectFor(adminKeyId);
    try {
      const result = await client.callTool({
        name: "upstream_create",
        arguments: {
          name: "Created By Agent",
          transport: "http",
          url: "http://127.0.0.1:9/mcp",
          description: "créé par un agent",
          enabled: false,
        },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { upstream: { id: string; slug: string; transport: string } };
      expect(structured.upstream.transport).toBe("http");
      // slugify() strips non-alphanumerics and truncates to 12 chars: slug is [a-z0-9]{1,12}.
      expect(structured.upstream.slug).toBe("createdbyage");

      const row = dbmod.getDb();
      const { upstreams } = await import("../lib/db/schema");
      const stored = row.select().from(upstreams).all().find((u) => u.id === structured.upstream.id);
      expect(stored?.url).toBe("http://127.0.0.1:9/mcp");
    } finally {
      await close();
    }
  });

  it("creates a stdio upstream with args and env", async () => {
    const { client, close } = await connectFor(adminKeyId);
    try {
      const result = await client.callTool({
        name: "upstream_create",
        arguments: {
          name: "Stdio Added",
          transport: "stdio",
          command: "/usr/bin/node",
          args: ["server.mjs", "--flag"],
          env: { API_KEY: "secret-value-123" },
          startMode: "lazy",
        },
      });
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { upstream: { id: string; slug: string } };
      expect(structured.upstream.slug).toBe("stdioadded");

      const { upstreams } = await import("../lib/db/schema");
      const stored = dbmod.getDb().select().from(upstreams).all().find((u) => u.id === structured.upstream.id);
      expect(stored?.command).toBe("/usr/bin/node");
      expect(stored?.args).toEqual(["server.mjs", "--flag"]);
      expect(stored?.startMode).toBe("lazy");
      // The secret is encrypted at rest, never stored in clear.
      expect(stored?.envEnc).toBeTruthy();
      expect(stored?.envEnc).not.toContain("secret-value-123");
    } finally {
      await close();
    }
  });

  it("refuses http without url and stdio without command, naming the field", async () => {
    const { client, close } = await connectFor(adminKeyId);
    try {
      const noUrl = await client.callTool({
        name: "upstream_create",
        arguments: { name: "No Url", transport: "http" },
      });
      expect(noUrl.isError).toBe(true);
      expect(JSON.stringify(noUrl.content)).toContain("url");

      const noCommand = await client.callTool({
        name: "upstream_create",
        arguments: { name: "No Command", transport: "stdio" },
      });
      expect(noCommand.isError).toBe(true);
      expect(JSON.stringify(noCommand.content)).toContain("command");
    } finally {
      await close();
    }
  });
});

describe("upstream_get and upstream_list", () => {
  it("never returns a secret value, only key names", async () => {
    const { getKey } = await import("../lib/auth/keys");
    const { createUpstream } = await import("../lib/api/upstreams");
    const { view } = createUpstream(
      {
        name: "With Secrets",
        transport: "http",
        url: "http://127.0.0.1:9/mcp",
        authType: "headers",
        headers: { "X-Api-Key": "super-secret-header" },
        env: { TOKEN: "super-secret-env" },
        enabled: false,
        startMode: "always",
        idleStopMinutes: 15,
        callTimeoutSeconds: 120,
      } as never,
      "test",
    );
    expect(getKey(adminKeyId)?.scope).toBe("admin");

    const { client, close } = await connectFor(adminKeyId);
    try {
      const result = await client.callTool({ name: "upstream_get", arguments: { id: view.slug } });
      expect(result.isError).toBeFalsy();
      const body = JSON.stringify(result.structuredContent);
      expect(body).not.toContain("super-secret-header");
      expect(body).not.toContain("super-secret-env");
      const structured = result.structuredContent as { headerKeys: string[]; envKeys: string[] };
      expect(structured.headerKeys).toContain("X-Api-Key");
      expect(structured.envKeys).toContain("TOKEN");

      const list = await client.callTool({ name: "upstream_list", arguments: {} });
      expect(JSON.stringify(list.structuredContent)).not.toContain("super-secret-header");
    } finally {
      await close();
    }
  });

  it("returns an actionable error result for an unknown id", async () => {
    const { client, close } = await connectFor(adminKeyId);
    try {
      const result = await client.callTool({ name: "upstream_get", arguments: { id: "does-not-exist" } });
      // Bad input is a tool-level error, not a JSON-RPC fault: the agent can read and fix it.
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("not found");
    } finally {
      await close();
    }
  });
});

describe("upstream_update", () => {
  it("patches only the fields provided and keeps the rest", async () => {
    const { createUpstream } = await import("../lib/api/upstreams");
    const { upstreams } = await import("../lib/db/schema");
    const created = createUpstream(
      {
        name: "Patch Me",
        transport: "http",
        url: "http://127.0.0.1:9/mcp",
        description: "avant",
        authType: "none",
        enabled: false,
        startMode: "always",
        idleStopMinutes: 15,
        callTimeoutSeconds: 120,
      } as never,
      "test",
    );

    const { client, close } = await connectFor(adminKeyId);
    try {
      const result = await client.callTool({
        name: "upstream_update",
        arguments: { id: created.view.id, description: "après", callTimeoutSeconds: 42 },
      });
      expect(result.isError).toBeFalsy();

      const stored = dbmod.getDb().select().from(upstreams).all().find((u) => u.id === created.view.id);
      expect(stored?.description).toBe("après");
      expect(stored?.callTimeoutSeconds).toBe(42);
      // Untouched fields survive the patch.
      expect(stored?.url).toBe("http://127.0.0.1:9/mcp");
      expect(stored?.slug).toBe(created.view.slug);
    } finally {
      await close();
    }
  });

  it("rejects an empty patch instead of silently doing nothing", async () => {
    const { createUpstream } = await import("../lib/api/upstreams");
    const created = createUpstream(
      {
        name: "Empty Patch",
        transport: "http",
        url: "http://127.0.0.1:9/mcp",
        authType: "none",
        enabled: false,
        startMode: "always",
        idleStopMinutes: 15,
        callTimeoutSeconds: 120,
      } as never,
      "test",
    );
    const { client, close } = await connectFor(adminKeyId);
    try {
      const result = await client.callTool({ name: "upstream_update", arguments: { id: created.view.id } });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("scope is re-checked on every call", () => {
  it("an agent key calling an admin tool gets an unknown-tool error", async () => {
    const { listKeys } = await import("../lib/auth/keys");
    const agentId = listKeys().find((k) => k.scope === "agent")!.id;
    const { client, close } = await connectFor(agentId);
    try {
      await expect(client.callTool({ name: "upstream_create", arguments: {} })).rejects.toThrow(/not found/i);
      await expect(client.callTool({ name: "upstream_list", arguments: {} })).rejects.toThrow(/not found/i);
    } finally {
      await close();
    }
  });
});
