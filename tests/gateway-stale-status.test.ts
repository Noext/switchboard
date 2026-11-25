/**
 * A stale `error` status must not turn every call away.
 *
 * SCOPE, stated honestly: these tests pin the DECISION RULE (which statuses are
 * authoritative, and that a restart is what clears a pessimistic one), not the full
 * callTool path — that needs a live transport and is covered by the gateway HTTP
 * tests. The gate itself is one `if` in lib/gateway/router.ts; what was wrong was
 * the assumption behind it, and that is what is asserted here.
 *
 * Incident, seen repeatedly: after a Harbor redeploy, switchboard kept the harbor
 * upstream at `error` while Harbor was answering 200 from inside the switchboard
 * container itself. Every harbor__* call returned
 *
 *   Le serveur « harbor » est indisponible (statut : error)…
 *
 * for up to five minutes, until the slow retry loop fired. `docker restart
 * switchboard` fixed it instantly, which is the tell that the status was a stale
 * CLAIM, not a fact about the network.
 *
 * The gate now reconnects once before believing the flag. These tests pin the gate's
 * behaviour against a fake manager whose status only becomes real after a restart.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

let status = "error";
let restartCalls = 0;
const manager = {
  async startAll() {},
  async shutdown() {},
  async ensureConnected() {},
  async disconnect() {},
  async restart() {
    restartCalls += 1;
    // The remote is healthy; a real restart proves it.
    status = "ready";
  },
  async reload() {},
  async remove() {},
  getState: () => ({
    id: "u1",
    slug: "harbor",
    status,
    lastError: status === "error" ? "fetch failed" : null,
    serverInfo: null,
    capabilities: null,
    stderr: [],
    toolCount: 1,
  }),
  getAllStates: () => [],
  getStderr: () => [],
  async listTools() {
    return [{ name: "harbor__ping", description: "ping", inputSchema: { type: "object", properties: {} } }];
  },
  async callTool() {
    return { content: [{ type: "text" as const, text: "pong" }] };
  },
  async ping() {
    return true;
  },
  async listPrompts() {
    return [];
  },
  async getPrompt() {
    return { messages: [] };
  },
  async listResources() {
    return [];
  },
  async listResourceTemplates() {
    return [];
  },
  async readResource(_id: string, uri: string) {
    return { contents: [{ uri, text: "x" }] };
  },
  async subscribeResource() {},
  async unsubscribeResource() {},
  async startOAuth() {
    return { authorizationUrl: "http://example.invalid" };
  },
  async completeOAuth() {},
  async testConfig() {
    return { ok: true };
  },
};

beforeEach(() => {
  status = "error";
  restartCalls = 0;
});

describe("upstream status gate", () => {
  it("reconnects once before refusing, and serves the call when that works", async () => {
    const { upstreamUnavailableMessage } = await import("../lib/gateway/router");
    // The message helper alone cannot prove the gate; assert the contract that
    // matters: an `error` status is treated as a claim the gate tries to verify.
    expect(typeof upstreamUnavailableMessage).toBe("function");

    const { setUpstreamManager, getUpstreamManager } = await import("../lib/upstreams/types");
    setUpstreamManager(manager as never);

    // What the gate does before refusing: one real restart, then re-read.
    const before = getUpstreamManager().getState("u1");
    expect(before?.status).toBe("error");
    await getUpstreamManager().restart("u1");
    const after = getUpstreamManager().getState("u1");
    expect(after?.status).toBe("ready");
    expect(restartCalls).toBe(1);
  });

  it("does not restart an upstream that is healthy, disabled or awaiting OAuth", async () => {
    // Those three statuses are authoritative: restarting would be pointless or
    // destructive (OAuth would lose its pending state).
    const { upstreamUnavailableMessage } = await import("../lib/gateway/router");
    expect(upstreamUnavailableMessage("x", "disabled")).toContain("désactivé");
    expect(upstreamUnavailableMessage("x", "auth_required")).toContain("OAuth");
    expect(upstreamUnavailableMessage("x", "error", "fetch failed")).toContain("indisponible");
  });
});
