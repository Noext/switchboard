import { describe, expect, it } from "vitest";
import { computeEffectiveAccess, checkToolAccess, type AccessInput } from "../lib/auth/access";
import type { AccessGrant } from "../lib/types";

const NOW = 1_700_000_000_000;

function baseInput(over: Partial<AccessInput> = {}): AccessInput {
  return {
    key: { id: "k1", scope: "agent", revokedAt: null, expiresAt: null },
    roleIds: [],
    grants: [],
    denies: [],
    catalog: {
      u1: { slug: "toto", status: "ready", tools: ["A", "B", "C", "D"], prompts: [], resources: [], disabledTools: [] },
      u2: { slug: "gh", status: "ready", tools: ["create_issue"], prompts: [], resources: [], disabledTools: [] },
    },
    ...over,
  };
}

function keyGrant(tools: string[], toolMode: "all" | "selected" = "selected", upstreamId = "u1"): AccessGrant {
  return {
    grantId: "g-" + upstreamId + toolMode + tools.join(""),
    upstreamId,
    toolMode,
    tools,
    prompts: false,
    resources: false,
    source: { type: "key", id: "k1", label: "own" },
  };
}

function roleGrant(roleId: string, tools: string[], toolMode: "all" | "selected" = "all", upstreamId = "u1"): AccessGrant {
  return {
    grantId: "g-" + roleId + upstreamId,
    upstreamId,
    toolMode,
    tools,
    prompts: false,
    resources: false,
    source: { type: "role", id: roleId, label: roleId },
  };
}

describe("computeEffectiveAccess", () => {
  it("spec §7.3: sk-aaa selected A,B,C -> sees A,B,C not D", () => {
    const a = computeEffectiveAccess(baseInput({ grants: [keyGrant(["A", "B", "C"])] }), NOW);
    expect(a.upstreams.u1.tools).toEqual(["A", "B", "C"]);
    expect(a.publicTools).toContain("toto__A");
    expect(a.publicTools).not.toContain("toto__D");
  });

  it("spec §7.3: sk-bbb selected B -> sees only B", () => {
    const a = computeEffectiveAccess(baseInput({ grants: [keyGrant(["B"])] }), NOW);
    expect(a.upstreams.u1.tools).toEqual(["B"]);
    expect(a.publicTools).toEqual(["toto__B"]);
  });

  it("spec §7.3: sk-ccc role all + deny C -> A,B,D incl. future tools", () => {
    const input = baseInput({
      roleIds: ["dev"],
      grants: [roleGrant("dev", [])],
      denies: [{ upstreamId: "u1", toolName: "C" }],
    });
    const a = computeEffectiveAccess(input, NOW);
    expect(a.upstreams.u1.tools).toEqual(["A", "B", "D"]);
    expect(a.upstreams.u1.removedByDeny).toEqual(["C"]);

    // A tool published later is granted automatically by mode "all".
    input.catalog.u1.tools.push("E");
    const a2 = computeEffectiveAccess(input, NOW);
    expect(a2.upstreams.u1.tools).toEqual(["A", "B", "D", "E"]);
  });

  it("a new tool stays hidden in selected mode", () => {
    const input = baseInput({ grants: [keyGrant(["A", "B", "C"])] });
    input.catalog.u1.tools.push("E");
    const a = computeEffectiveAccess(input, NOW);
    expect(a.upstreams.u1.tools).toEqual(["A", "B", "C"]);
  });

  it("deny on the whole upstream removes access", () => {
    const a = computeEffectiveAccess(
      baseInput({ grants: [keyGrant([], "all")], denies: [{ upstreamId: "u1", toolName: null }] }),
      NOW,
    );
    expect(a.upstreams.u1).toBeUndefined();
    expect(a.publicTools).toEqual([]);
  });

  it("union across multiple grants and modes: 'all' wins", () => {
    const a = computeEffectiveAccess(
      baseInput({ roleIds: ["r"], grants: [keyGrant(["A"]), roleGrant("r", [], "all")] }),
      NOW,
    );
    expect(a.upstreams.u1.tools).toEqual(["A", "B", "C", "D"]);
  });

  it("ignores grants from roles the key does not have", () => {
    const a = computeEffectiveAccess(baseInput({ grants: [roleGrant("other", [], "all")] }), NOW);
    expect(a.upstreams.u1).toBeUndefined();
  });

  it("globally disabled tools never appear", () => {
    const input = baseInput({ grants: [keyGrant([], "all")] });
    input.catalog.u1.disabledTools = ["B"];
    const a = computeEffectiveAccess(input, NOW);
    expect(a.upstreams.u1.tools).toEqual(["A", "C", "D"]);
  });

  it("non-ready upstream yields no tools", () => {
    const input = baseInput({ grants: [keyGrant([], "all")] });
    input.catalog.u1.status = "error";
    const a = computeEffectiveAccess(input, NOW);
    expect(a.upstreams.u1.tools).toEqual([]);
    expect(a.publicTools).toEqual([]);
  });

  it("revoked key has no access", () => {
    const a = computeEffectiveAccess(
      baseInput({ key: { id: "k1", scope: "agent", revokedAt: NOW - 1, expiresAt: null }, grants: [keyGrant([], "all")] }),
      NOW,
    );
    expect(a.publicTools).toEqual([]);
  });

  it("expired key has no access", () => {
    const a = computeEffectiveAccess(
      baseInput({ key: { id: "k1", scope: "agent", revokedAt: null, expiresAt: NOW - 1 }, grants: [keyGrant([], "all")] }),
      NOW,
    );
    expect(a.publicTools).toEqual([]);
  });

  it("prompts/resources are OR-ed across sources", () => {
    const g1 = { ...keyGrant(["A"]), prompts: true };
    const g2 = { ...roleGrant("r", [], "all", "u2"), resources: true };
    const a = computeEffectiveAccess(baseInput({ roleIds: ["r"], grants: [g1, g2] }), NOW);
    expect(a.upstreams.u1.prompts).toEqual([]);
    expect(a.upstreams.u2.resources).toEqual([]);
    expect(a.upstreams.u1.resources).toBeNull();
  });
});

describe("checkToolAccess", () => {
  const slugs = new Map([
    ["toto", { id: "u1", status: "ready" }],
    ["gh", { id: "u2", status: "ready" }],
  ]);

  it("allows a granted tool", () => {
    const a = computeEffectiveAccess(baseInput({ grants: [keyGrant(["B"])] }), NOW);
    expect(checkToolAccess(a, "toto__B", slugs, new Map()).allowed).toBe(true);
  });

  it("rejects a non-granted tool the same way as an unknown one", () => {
    const a = computeEffectiveAccess(baseInput({ grants: [keyGrant(["B"])] }), NOW);
    const notGranted = checkToolAccess(a, "toto__A", slugs, new Map());
    const unknown = checkToolAccess(a, "nope__A", slugs, new Map());
    expect(notGranted.allowed).toBe(false);
    expect(unknown.allowed).toBe(false);
  });

  it("rejects a globally disabled tool", () => {
    const a = computeEffectiveAccess(baseInput({ grants: [keyGrant([], "all")] }), NOW);
    const disabled = new Map([["u1", new Set(["C"])]]);
    expect(checkToolAccess(a, "toto__C", slugs, disabled).allowed).toBe(false);
  });
});
