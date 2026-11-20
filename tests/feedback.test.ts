import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Spec §6.5 tests: validation bounds, dedupe (same key + tool + category + normalised title
 * within 24h), the 20/hour/key rate limit, secret masking, and the automatic link to the last
 * failed call of the session.
 */

let dir: string;
let dbmod: typeof import("../lib/db");
const envBackup = { ...process.env };

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-feedback-"));
  process.env.SWITCHBOARD_DATA_DIR = dir;
  process.env.SWITCHBOARD_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
  vi.resetModules();
  dbmod = await import("../lib/db");
});

afterEach(async () => {
  dbmod?.closeDb();
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...envBackup };
});

async function seedKey(id = "key-1", name = "claude-laptop") {
  const { apiKeys } = await import("../lib/db/schema");
  dbmod.getDb()
    .insert(apiKeys)
    .values({
      id,
      name,
      prefix: "sk-sw-abcde",
      hash: "hash-" + id,
      scope: "agent",
      exposureMode: "direct",
      createdAt: Date.now(),
    })
    .run();
}

async function seedUpstream(slug = "toto", id = "u1") {
  const { upstreams, upstreamItems } = await import("../lib/db/schema");
  const now = Date.now();
  dbmod.getDb()
    .insert(upstreams)
    .values({
      id,
      slug,
      name: "Toto",
      transport: "http",
      url: "http://localhost:9999/mcp",
      authType: "none",
      enabled: true,
      startMode: "always",
      status: "ready",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  dbmod.getDb()
    .insert(upstreamItems)
    .values({ upstreamId: id, kind: "tool", name: "B", definition: { name: "B" }, fetchedAt: now })
    .run();
  const { invalidateCatalog } = await import("../lib/catalog/catalog");
  invalidateCatalog("test-seed");
}

const baseInput = {
  category: "tool_error" as const,
  title: "Outil en erreur",
  description: "L'appel a renvoyé une erreur 500 alors que l'entrée était valide.",
};

describe("feedback input schema (§6.5)", () => {
  it("accepts a minimal input and defaults severity to medium", async () => {
    const { feedbackInputSchema } = await import("../lib/feedback");
    const parsed = feedbackInputSchema.parse(baseInput);
    expect(parsed.severity).toBe("medium");
    expect(parsed.tool).toBeUndefined();
  });

  it("rejects an unknown category", async () => {
    const { feedbackInputSchema } = await import("../lib/feedback");
    expect(feedbackInputSchema.safeParse({ ...baseInput, category: "nope" }).success).toBe(false);
  });

  it("enforces title <= 120 and description <= 4000", async () => {
    const { feedbackInputSchema } = await import("../lib/feedback");
    expect(feedbackInputSchema.safeParse({ ...baseInput, title: "x".repeat(121) }).success).toBe(false);
    expect(feedbackInputSchema.safeParse({ ...baseInput, title: "x".repeat(120) }).success).toBe(true);
    expect(feedbackInputSchema.safeParse({ ...baseInput, description: "x".repeat(4001) }).success).toBe(false);
    expect(feedbackInputSchema.safeParse({ ...baseInput, description: "x".repeat(4000) }).success).toBe(true);
  });

  it("exposes the category and severity enums as const arrays", async () => {
    const { FEEDBACK_CATEGORIES, FEEDBACK_SEVERITIES } = await import("../lib/feedback");
    expect([...FEEDBACK_CATEGORIES]).toEqual([
      "tool_error",
      "missing_tool",
      "access_needed",
      "bad_description",
      "slow",
      "bug",
      "other",
    ]);
    expect([...FEEDBACK_SEVERITIES]).toEqual(["low", "medium", "high", "blocking"]);
  });
});

describe("recordFeedback", () => {
  it("fills keyId, sessionId, clientInfo and timestamps server-side", async () => {
    await seedKey();
    const { recordFeedback, getFeedback } = await import("../lib/feedback");
    const result = recordFeedback(baseInput, {
      keyId: "key-1",
      sessionId: "sess-1",
      clientInfo: { name: "claude-code", version: "1.2.3" },
    });
    expect(result.status).toBe("recorded");
    expect(result.id).toBeTruthy();
    expect(result.message).toContain("retour enregistré");

    const detail = getFeedback(result.id);
    expect(detail).not.toBeNull();
    expect(detail!.keyId).toBe("key-1");
    expect(detail!.sessionId).toBe("sess-1");
    expect(detail!.clientInfo).toMatchObject({ name: "claude-code", version: "1.2.3" });
    expect(detail!.status).toBe("new");
    expect(detail!.occurrences).toBe(1);
    expect(detail!.severity).toBe("medium");
    expect(detail!.lastOccurrenceAt).toBeGreaterThan(0);
    expect(detail!.createdAt).toBe(detail!.lastOccurrenceAt);
  });

  it("dedupes the same key + tool + category + normalised title within 24h (§6.5)", async () => {
    await seedKey();
    const { recordFeedback, getFeedback, listFeedback } = await import("../lib/feedback");
    const now = Date.now();

    const first = recordFeedback({ ...baseInput, tool: "toto__B" }, { keyId: "key-1" }, now);
    // Same title with different spacing/case: normalisation must merge it.
    const second = recordFeedback(
      { ...baseInput, tool: "toto__B", title: "  OUTIL   en ERREUR " },
      { keyId: "key-1" },
      now + 1000,
    );

    expect(first.status).toBe("recorded");
    expect(second.status).toBe("merged");
    expect(second.id).toBe(first.id);

    const detail = getFeedback(first.id)!;
    expect(detail.occurrences).toBe(2);
    expect(detail.lastOccurrenceAt).toBe(now + 1000);
    expect(listFeedback({}).total).toBe(1);

    // A different category or a different tool is a distinct feedback.
    recordFeedback({ ...baseInput, category: "bug", tool: "toto__B" }, { keyId: "key-1" }, now + 2000);
    recordFeedback({ ...baseInput, tool: "toto__A" }, { keyId: "key-1" }, now + 3000);
    expect(listFeedback({}).total).toBe(3);
  });

  it("does not merge a title seen more than 24h ago", async () => {
    await seedKey();
    const { recordFeedback } = await import("../lib/feedback");
    const now = Date.now();
    const first = recordFeedback(baseInput, { keyId: "key-1" }, now - 25 * 3_600_000);
    const second = recordFeedback(baseInput, { keyId: "key-1" }, now);
    expect(second.status).toBe("recorded");
    expect(second.id).not.toBe(first.id);
  });

  it("does not merge across different keys", async () => {
    await seedKey("key-1", "k1");
    await seedKey("key-2", "k2");
    const { recordFeedback } = await import("../lib/feedback");
    const a = recordFeedback(baseInput, { keyId: "key-1" });
    const b = recordFeedback(baseInput, { keyId: "key-2" });
    expect(a.id).not.toBe(b.id);
  });

  it("resets a resolved feedback to new when it recurs (§6.5)", async () => {
    await seedKey();
    const { recordFeedback, updateFeedback, getFeedback } = await import("../lib/feedback");
    const first = recordFeedback(baseInput, { keyId: "key-1" });
    updateFeedback(first.id, { status: "resolved" });
    expect(getFeedback(first.id)!.status).toBe("resolved");
    expect(getFeedback(first.id)!.resolvedAt).toBeTypeOf("number");

    const again = recordFeedback(baseInput, { keyId: "key-1" });
    expect(again.status).toBe("merged");
    const detail = getFeedback(first.id)!;
    expect(detail.status).toBe("new");
    expect(detail.resolvedAt).toBeNull();
    expect(detail.occurrences).toBe(2);
  });

  it("links the last failed call of the session and derives the upstream slug", async () => {
    await seedKey();
    await seedUpstream();
    const { logCall } = await import("../lib/logs");
    // An older failure and a newer success: the newest *failure* must be linked.
    logCall({ keyId: "key-1", sessionId: "sess-1", kind: "tool", name: "toto__B", ok: false, errorCode: "500" });
    const failing = logCall({
      keyId: "key-1",
      sessionId: "sess-1",
      kind: "tool",
      name: "toto__B",
      ok: false,
      errorCode: "timeout",
    });
    logCall({ keyId: "key-1", sessionId: "sess-1", kind: "tool", name: "toto__B", ok: true });

    const { recordFeedback, getFeedback } = await import("../lib/feedback");
    const result = recordFeedback({ ...baseInput, tool: "toto__B" }, { keyId: "key-1", sessionId: "sess-1" });
    const detail = getFeedback(result.id)!;
    expect(detail.relatedCallId).toBe(failing);
    expect(detail.upstreamSlug).toBe("toto");
    expect(detail.relatedCall?.errorCode).toBe("timeout");
    expect(detail.recentCalls.length).toBe(3);
  });

  it("accepts an unknown or unauthorized tool without revealing anything (§6.5)", async () => {
    await seedKey();
    const { recordFeedback, getFeedback } = await import("../lib/feedback");
    const result = recordFeedback(
      { ...baseInput, category: "access_needed", tool: "secret__hidden" },
      { keyId: "key-1" },
    );
    const detail = getFeedback(result.id)!;
    expect(detail.toolName).toBe("secret__hidden");
    // The slug is only recorded when the upstream actually exists in the catalog.
    expect(detail.upstreamSlug).toBeNull();
    expect(detail.relatedCallId).toBeNull();
    expect(result.message).not.toMatch(/exists|inconnu|autorisé|unauthor/i);
  });

  it("masks secrets found in every stored text field", async () => {
    await seedKey();
    const { getRedactor } = await import("../lib/redact");
    getRedactor().register("super-secret-token-value");
    const { recordFeedback, getFeedback } = await import("../lib/feedback");
    const result = recordFeedback(
      {
        ...baseInput,
        title: "auth failed with super-secret-token-value",
        description: "the header Authorization: Bearer super-secret-token-value was rejected",
        attempted_action: "call with super-secret-token-value",
        error_message: "401 for super-secret-token-value",
      },
      { keyId: "key-1" },
    );
    const detail = getFeedback(result.id)!;
    for (const field of [detail.title, detail.description, detail.attemptedAction, detail.errorMessage]) {
      expect(field).not.toContain("super-secret-token-value");
    }
    expect(detail.title).toContain("••••");
    expect(detail.errorMessage).toContain("••••");
  });

  it("enforces 20 reports per hour per key (§6.5)", async () => {
    await seedKey();
    const { recordFeedback, FeedbackRateLimitError, resetFeedbackRateLimit } = await import("../lib/feedback");
    resetFeedbackRateLimit();
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      recordFeedback({ ...baseInput, title: "report " + i }, { keyId: "key-1" }, now + i);
    }
    expect(() => recordFeedback({ ...baseInput, title: "report 21" }, { keyId: "key-1" }, now + 21)).toThrow(
      FeedbackRateLimitError,
    );

    // Another key is unaffected.
    await seedKey("key-2", "k2");
    expect(() => recordFeedback({ ...baseInput, title: "other key" }, { keyId: "key-2" }, now + 22)).not.toThrow();

    // The window slides: past the hour, the oldest entries stop counting.
    resetFeedbackRateLimit();
    expect(() => recordFeedback({ ...baseInput, title: "after an hour" }, { keyId: "key-1" }, now + 3_600_001)).not.toThrow();
  });

  it("carries a machine-readable code and retry delay on the rate-limit error", async () => {
    await seedKey();
    const { recordFeedback, FeedbackRateLimitError, resetFeedbackRateLimit } = await import("../lib/feedback");
    resetFeedbackRateLimit();
    const now = Date.now();
    for (let i = 0; i < 20; i++) recordFeedback({ ...baseInput, title: "r" + i }, { keyId: "key-1" }, now);
    try {
      recordFeedback({ ...baseInput, title: "blocked" }, { keyId: "key-1" }, now + 60_000);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(FeedbackRateLimitError);
      const rate = error as InstanceType<typeof FeedbackRateLimitError>;
      expect(rate.code).toBe("feedback_rate_limit");
      expect(rate.limit).toBe(20);
      expect(rate.retryAfterSeconds).toBeGreaterThan(0);
    }
  });
});

describe("admin helpers", () => {
  it("lists with filters and pagination (§9)", async () => {
    await seedKey();
    await seedUpstream();
    const { recordFeedback, listFeedback } = await import("../lib/feedback");
    recordFeedback({ ...baseInput, category: "tool_error", tool: "toto__B", severity: "high" }, { keyId: "key-1" });
    recordFeedback({ ...baseInput, category: "bug", title: "Bug title", severity: "low" }, { keyId: "key-1" });
    recordFeedback(
      { ...baseInput, category: "access_needed", title: "Need access", tool: "toto__A" },
      { keyId: "key-1" },
    );

    expect(listFeedback({}).total).toBe(3);
    expect(listFeedback({ category: "bug" }).items.map((i) => i.title)).toEqual(["Bug title"]);
    expect(listFeedback({ severity: "high" }).total).toBe(1);
    expect(listFeedback({ category: ["bug", "access_needed"] }).total).toBe(2);
    expect(listFeedback({ toolName: "toto__B" }).total).toBe(1);
    expect(listFeedback({ keyId: "key-1" }).total).toBe(3);
    expect(listFeedback({ upstreamSlug: "toto" }).total).toBe(2);
    expect(listFeedback({ search: "Need" }).total).toBe(1);

    const page = listFeedback({ limit: 2, offset: 1 });
    expect(page.items.length).toBe(2);
    expect(page.total).toBe(3);
    expect(page.limit).toBe(2);
    expect(page.items[0].keyName).toBe("claude-laptop");
  });

  it("updates status, sets resolvedAt and writes an audit event", async () => {
    await seedKey();
    const { recordFeedback, updateFeedback, listFeedback } = await import("../lib/feedback");
    const created = recordFeedback(baseInput, { keyId: "key-1" });
    const updated = updateFeedback(created.id, { status: "acknowledged", adminNote: "on it" }, "ui");
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("acknowledged");
    expect(updated!.adminNote).toBe("on it");
    expect(updated!.resolvedAt).toBeNull();

    updateFeedback(created.id, { status: "wont_fix" });
    const row = listFeedback({}).items[0];
    expect(row.status).toBe("wont_fix");
    expect(row.resolvedAt).toBeTypeOf("number");

    const { getDb } = await import("../lib/db");
    const { events } = await import("../lib/db/schema");
    const types = getDb()
      .select({ type: events.type })
      .from(events)
      .all()
      .map((e) => e.type);
    expect(types).toContain("feedback.status_changed");
  });

  it("returns null for an unknown id", async () => {
    const { updateFeedback, getFeedback } = await import("../lib/feedback");
    expect(updateFeedback("nope", { status: "resolved" })).toBeNull();
    expect(getFeedback("nope")).toBeNull();
  });

  it("bulk-updates a set of ids", async () => {
    await seedKey();
    const { recordFeedback, bulkUpdateStatus, listFeedback } = await import("../lib/feedback");
    const ids = [1, 2, 3].map((i) => recordFeedback({ ...baseInput, title: "f" + i }, { keyId: "key-1" }).id);
    const result = bulkUpdateStatus(ids.slice(0, 2), "in_progress");
    expect(result.updated).toBe(2);
    expect(listFeedback({ status: "in_progress" }).total).toBe(2);
    expect(listFeedback({ status: "new" }).total).toBe(1);

    // Unknown ids are tolerated; the status itself is validated.
    expect(bulkUpdateStatus(["ghost"], "resolved").updated).toBe(0);
    expect(() => bulkUpdateStatus(ids, "bogus" as never)).toThrow();
  });

  it("reports stats by status and open severity for the dashboard", async () => {
    await seedKey();
    const { recordFeedback, feedbackStats, updateFeedback } = await import("../lib/feedback");
    const a = recordFeedback({ ...baseInput, severity: "blocking", title: "a" }, { keyId: "key-1" });
    recordFeedback({ ...baseInput, severity: "low", title: "b" }, { keyId: "key-1" });
    updateFeedback(a.id, { status: "resolved" });

    const stats = feedbackStats();
    expect(stats.byStatus.new).toBe(1);
    expect(stats.byStatus.resolved).toBe(1);
    expect(stats.open).toBe(1);
    expect(stats.openBySeverity.low).toBe(1);
    expect(stats.openBySeverity.blocking).toBe(0);
  });
});

describe("apprise notification (§6.5)", () => {
  it("posts high/blocking feedback when apprise is enabled", async () => {
    await seedKey();
    const { updateSettings } = await import("../lib/settings");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      updateSettings({ appriseEnabled: true, appriseUrl: "http://apprise.local:8000/notify/sb" });
      const { recordFeedback } = await import("../lib/feedback");
      recordFeedback({ ...baseInput, severity: "blocking", title: "Bloquant" }, { keyId: "key-1" });
      recordFeedback({ ...baseInput, severity: "low", title: "Faible" }, { keyId: "key-1" });
      // Notification is fire-and-forget; give the microtask a tick.
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(calls[0].init.body));
      expect(body.urls).toBe("http://apprise.local:8000/notify/sb");
      expect(body.title).toContain("Bloquant");
      expect(body.body).toContain("blocking");
    } finally {
      vi.unstubAllGlobals();
      updateSettings({ appriseEnabled: false, appriseUrl: "" });
    }
  });

  it("never throws when apprise is unreachable", async () => {
    await seedKey();
    const { updateSettings } = await import("../lib/settings");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    try {
      updateSettings({ appriseEnabled: true, appriseUrl: "http://127.0.0.1:1/notify" });
      const { recordFeedback } = await import("../lib/feedback");
      expect(() => recordFeedback({ ...baseInput, severity: "blocking" }, { keyId: "key-1" })).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      vi.unstubAllGlobals();
      updateSettings({ appriseEnabled: false, appriseUrl: "" });
    }
  });
});
describe("admin API routes (/api/v1/feedback)", () => {
  async function cookie(): Promise<string> {
    const { createSessionToken, SESSION_COOKIE } = await import("../lib/auth/session");
    return SESSION_COOKIE + "=" + createSessionToken();
  }

  it("rejects an unauthenticated request", async () => {
    const { GET } = await import("../app/api/v1/feedback/route");
    const res = await GET(new Request("http://localhost/api/v1/feedback"));
    expect(res.status).toBe(401);
  });

  it("lists, filters and validates filters", async () => {
    await seedKey();
    const { recordFeedback } = await import("../lib/feedback");
    recordFeedback({ ...baseInput, category: "bug", title: "Bug A", severity: "high" }, { keyId: "key-1" });
    recordFeedback({ ...baseInput, category: "slow", title: "Slow B" }, { keyId: "key-1" });

    const { GET } = await import("../app/api/v1/feedback/route");
    const headers = { cookie: await cookie() };
    const ok = await GET(new Request("http://localhost/api/v1/feedback?category=bug&severity=high", { headers }));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.total).toBe(1);
    expect(body.items[0].title).toBe("Bug A");
    expect(body.stats.byStatus.new).toBe(2);

    const bad = await GET(new Request("http://localhost/api/v1/feedback?status=nope", { headers }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).allowed).toContain("new");
  });

  it("gets one entry with its call context, patches it and 404s on unknown ids", async () => {
    await seedKey();
    const { recordFeedback, getFeedback } = await import("../lib/feedback");
    const created = recordFeedback(baseInput, { keyId: "key-1", sessionId: "s1" });

    const idRoute = await import("../app/api/v1/feedback/[id]/route");
    const headers = { cookie: await cookie() };
    const ctx = { params: Promise.resolve({ id: created.id }) };

    const got = await idRoute.GET(new Request("http://localhost/api/v1/feedback/" + created.id, { headers }), ctx);
    expect(got.status).toBe(200);
    const detail = await got.json();
    expect(detail.feedback.id).toBe(created.id);
    expect(detail.relatedCall).toBeNull();
    expect(Array.isArray(detail.recentCalls)).toBe(true);

    const patched = await idRoute.PATCH(
      new Request("http://localhost/x", {
        method: "PATCH",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ status: "in_progress", adminNote: "ok" }),
      }),
      ctx,
    );
    expect(patched.status).toBe(200);
    expect(getFeedback(created.id)!.status).toBe("in_progress");
    expect(getFeedback(created.id)!.adminNote).toBe("ok");

    const missing = await idRoute.GET(
      new Request("http://localhost/x", { headers }),
      { params: Promise.resolve({ id: "ghost" }) },
    );
    expect(missing.status).toBe(404);
  });

  it("bulk-updates and rejects an empty or invalid body", async () => {
    await seedKey();
    const { recordFeedback } = await import("../lib/feedback");
    const ids = [1, 2].map((i) => recordFeedback({ ...baseInput, title: "t" + i }, { keyId: "key-1" }).id);
    const { POST } = await import("../app/api/v1/feedback/bulk/route");
    const headers = { cookie: await cookie(), "content-type": "application/json" };

    const ok = await POST(
      new Request("http://localhost/x", { method: "POST", headers, body: JSON.stringify({ ids, status: "wont_fix" }) }),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).updated).toBe(2);

    const invalid = await POST(
      new Request("http://localhost/x", { method: "POST", headers, body: JSON.stringify({ ids: [], status: "wont_fix" }) }),
    );
    expect(invalid.status).toBe(400);

    const badStatus = await POST(
      new Request("http://localhost/x", { method: "POST", headers, body: JSON.stringify({ ids, status: "nope" }) }),
    );
    expect(badStatus.status).toBe(400);
  });
});
