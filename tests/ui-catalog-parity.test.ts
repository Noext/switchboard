import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Parity guard for the admin UI's catalog read model.
 *
 * The pages under app/(ui)/ build their catalog from the DB (components/catalog-view.ts) instead
 * of trusting a cached snapshot. That is only safe if the two views agree, so this test binds
 * them together: if the naming or collision rules change in lib/catalog, the UI would silently
 * drift and this fails.
 */

process.env.SWITCHBOARD_DATA_DIR = mkdtempSync(path.join(tmpdir(), "sb-catalog-parity-"));
process.env.SWITCHBOARD_SECRET = "0123456789abcdef0123456789abcdef";
process.env.SWITCHBOARD_ADMIN_PASSWORD = "test";

type Db = typeof import("../lib/db");
type Schema = typeof import("../lib/db/schema");
type View = typeof import("../components/catalog-view");
type Catalog = typeof import("../lib/catalog/catalog");
type Overrides = typeof import("../lib/catalog/overrides");

let db: Db;
let schema: Schema;
let view: View;
let catalog: Catalog;
let overrides: Overrides;

beforeAll(async () => {
  db = await import("../lib/db");
  schema = await import("../lib/db/schema");
  view = await import("../components/catalog-view");
  catalog = await import("../lib/catalog/catalog");
  overrides = await import("../lib/catalog/overrides");
});

function seedUpstream(input: {
  slug: string;
  name: string;
  status?: "ready" | "connecting";
  tools?: Array<{ name: string; description?: string }>;
  prompts?: string[];
  resources?: string[];
  templates?: string[];
}): string {
  const handle = db.getDb();
  const id = randomUUID();
  const now = Date.now();
  handle
    .insert(schema.upstreams)
    .values({
      id,
      slug: input.slug,
      name: input.name,
      transport: "http",
      url: "https://" + input.slug + ".example/mcp",
      authType: "none",
      enabled: true,
      startMode: "always",
      status: input.status ?? "ready",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const insert = (kind: "tool" | "prompt" | "resource" | "resource_template", name: string, definition: unknown) =>
    handle
      .insert(schema.upstreamItems)
      .values({ upstreamId: id, kind, name, definition: definition as never, fetchedAt: now })
      .run();

  for (const tool of input.tools ?? []) {
    insert("tool", tool.name, { name: tool.name, description: tool.description ?? null, inputSchema: {} });
  }
  for (const prompt of input.prompts ?? []) insert("prompt", prompt, { name: prompt });
  for (const uri of input.resources ?? []) insert("resource", uri, { uri });
  for (const template of input.templates ?? []) insert("resource_template", template, { uriTemplate: template });
  return id;
}

/** Reads the same three tables through the UI's pure builder. */
function dbView() {
  const handle = db.getDb();
  return view.buildCatalogView(
    handle.select().from(schema.upstreams).all(),
    handle.select().from(schema.upstreamItems).all(),
    handle.select().from(schema.itemOverrides).all(),
  );
}

describe("DB catalog matches the gateway catalog", () => {
  it("resolves the same public tool, prompt, resource and template names", () => {
    const a = seedUpstream({
      slug: "gh",
      name: "GitHub",
      tools: [{ name: "create_issue", description: "Creer une issue" }, { name: "search_issues" }],
      prompts: ["triage"],
      resources: ["repo://readme"],
      templates: ["repo://{path}"],
    });
    // Same resource URI as gh: both must be rewritten to switchboard://slug/...
    const b = seedUpstream({
      slug: "jira",
      name: "Jira",
      status: "connecting",
      tools: [{ name: "create_issue" }],
      resources: ["repo://readme"],
    });

    const fromUi = new Map(dbView().map((u) => [u.id, u] as const));
    const snapshot = catalog.getCatalog().rebuild();

    for (const id of [a, b]) {
      const ui = fromUi.get(id);
      const snap = snapshot.upstreams[id];
      expect(ui, "ui view " + id).toBeTruthy();
      expect(snap, "snapshot view " + id).toBeTruthy();

      expect(ui!.tools.map((t) => t.publicName).sort()).toEqual(snap.tools.map((t) => t.publicName).sort());
      expect(ui!.prompts.map((p) => p.publicName).sort()).toEqual(snap.prompts.map((p) => p.publicName).sort());
      expect(ui!.resources.map((r) => r.publicName).sort()).toEqual(snap.resources.map((r) => r.publicName).sort());
      expect(ui!.resourceTemplates.map((r) => r.publicName).sort()).toEqual(
        snap.resourceTemplates.map((r) => r.publicName).sort(),
      );
    }

    // The colliding resource really is rewritten on both sides.
    expect(snapshot.upstreams[b].resources[0].publicName.startsWith("switchboard://")).toBe(true);
    expect(fromUi.get(b)!.resources[0].publicName).toBe(snapshot.upstreams[b].resources[0].publicName);
  });

  it("applies an alias and a global disable exactly like the gateway", () => {
    const id = seedUpstream({ slug: "toto", name: "Toto", tools: [{ name: "A" }, { name: "B" }, { name: "C" }] });

    overrides.setOverride(id, "tool", "A", { alias: "alpha" });
    overrides.setOverride(id, "tool", "C", { enabled: false });

    const ui = dbView().find((u) => u.id === id)!;
    const snap = catalog.getCatalog().rebuild().upstreams[id];

    const alpha = ui.tools.find((t) => t.name === "A")!;
    expect(alpha.publicName).toBe("toto__alpha");
    expect(alpha.publicName).toBe(snap.toolPublicNames.get("A"));

    // A globally disabled tool stays listed, flagged, and is filtered out of the access catalog.
    expect(ui.tools.find((t) => t.name === "C")!.globallyDisabled).toBe(true);
    expect(snap.tools.find((t) => t.name === "C")!.enabled).toBe(false);
    expect(ui.tools.filter((t) => !t.globallyDisabled).map((t) => t.name)).toEqual(["A", "B"]);
  });
});
