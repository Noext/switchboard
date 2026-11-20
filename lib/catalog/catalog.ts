import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { itemOverrides, upstreamItems, upstreams } from "../db/schema";
import { clearGlobalSingleton, globalSingleton } from "../runtime/global";
import type { CatalogEntry, ItemKind } from "../types";
import { buildPublicName, buildResourceUri, splitPublicName } from "./naming";

export interface UpstreamCatalogView {
  upstreamId: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  enabled: boolean;
  tools: CatalogEntry[];
  prompts: CatalogEntry[];
  resources: CatalogEntry[];
  resourceTemplates: CatalogEntry[];
  /** tool original name -> public name */
  toolPublicNames: Map<string, string>;
  promptPublicNames: Map<string, string>;
  /** resource original uri -> public uri */
  resourcePublicUris: Map<string, string>;
}

export interface CatalogSnapshot {
  version: number;
  builtAt: number;
  upstreams: Record<string, UpstreamCatalogView>;
  /** global public tool name -> routing info */
  toolsByPublicName: Map<string, { upstreamId: string; upstreamSlug: string; originalName: string; entry: CatalogEntry }>;
  promptsByPublicName: Map<string, { upstreamId: string; upstreamSlug: string; originalName: string; entry: CatalogEntry }>;
  resourcesByPublicUri: Map<string, { upstreamId: string; upstreamSlug: string; originalUri: string; entry: CatalogEntry }>;
  /** upstream slug -> upstreamId */
  upstreamIdBySlug: Map<string, string>;
}

class CatalogStore extends EventEmitter {
  private snapshot: CatalogSnapshot;
  private dirty = true;

  constructor() {
    super();
    this.setMaxListeners(0);
    this.snapshot = emptySnapshot();
  }

  /** Rebuilds from the DB cache table (fast, no I/O against upstreams). */
  rebuild(): CatalogSnapshot {
    const db = getDb();
    const ups = db.select().from(upstreams).all();
    const items = db.select().from(upstreamItems).all();
    const overrides = db.select().from(itemOverrides).all();

    const overrideMap = new Map<string, typeof overrides[number]>();
    for (const o of overrides) overrideMap.set(`${o.upstreamId}|${o.kind}|${o.name}`, o);

    const view: Record<string, UpstreamCatalogView> = {};
    for (const u of ups) {
      view[u.id] = {
        upstreamId: u.id,
        slug: u.slug,
        name: u.name,
        description: u.description,
        status: u.status,
        enabled: u.enabled,
        tools: [],
        prompts: [],
        resources: [],
        resourceTemplates: [],
        toolPublicNames: new Map(),
        promptPublicNames: new Map(),
        resourcePublicUris: new Map(),
      };
    }

    const toolsByPublicName = new Map<string, any>();
    const promptsByPublicName = new Map<string, any>();
    const resourcesByPublicUri = new Map<string, any>();

    // Detect resource URI collisions across upstreams.
    const uriCounts = new Map<string, number>();
    for (const it of items) {
      if (it.kind !== "resource") continue;
      uriCounts.set(it.name, (uriCounts.get(it.name) ?? 0) + 1);
    }

    for (const it of items) {
      const upstream = view[it.upstreamId];
      if (!upstream) continue;
      const ov = overrideMap.get(`${it.upstreamId}|${it.kind}|${it.name}`);
      const def = (it.definition ?? {}) as Record<string, any>;
      const base = {
        kind: it.kind as ItemKind,
        name: it.name,
        upstreamId: it.upstreamId,
        upstreamSlug: upstream.slug,
        description: ov?.descriptionOverride ?? def.description,
        definition: def,
        enabled: ov?.enabled ?? true,
        alias: ov?.alias ?? null,
        descriptionOverride: ov?.descriptionOverride ?? null,
      } as CatalogEntry;

      if (it.kind === "tool" || it.kind === "prompt") {
        const sourceName = ov?.alias && ov.alias.length > 0 ? ov.alias : it.name;
        const { publicName, truncated } = buildPublicName(upstream.slug, sourceName);
        const entry: CatalogEntry = { ...base, publicName, truncated };
        const target = it.kind === "tool" ? toolsByPublicName : promptsByPublicName;
        const names = it.kind === "tool" ? upstream.toolPublicNames : upstream.promptPublicNames;
        // Deduplicate: first writer wins; a collision gets a hash suffix.
        let finalName = publicName;
        while (target.has(finalName)) {
          finalName = buildPublicName(upstream.slug, `${sourceName}_${finalName.length}`).publicName;
        }
        entry.publicName = finalName;
        names.set(it.name, finalName);
        target.set(finalName, {
          upstreamId: it.upstreamId,
          upstreamSlug: upstream.slug,
          originalName: it.name,
          entry,
        });
        (it.kind === "tool" ? upstream.tools : upstream.prompts).push(entry);
      } else if (it.kind === "resource") {
        const collision = (uriCounts.get(it.name) ?? 0) > 1;
        const publicUri = buildResourceUri(upstream.slug, it.name, collision);
        const entry: CatalogEntry = { ...base, publicName: publicUri, definition: { ...def, uri: it.name } };
        upstream.resourcePublicUris.set(it.name, publicUri);
        upstream.resources.push(entry);
        resourcesByPublicUri.set(publicUri, {
          upstreamId: it.upstreamId,
          upstreamSlug: upstream.slug,
          originalUri: it.name,
          entry,
        });
      } else {
        const entry: CatalogEntry = {
          ...base,
          publicName: it.name,
          definition: { ...def, uriTemplate: def.uriTemplate ?? it.name },
        };
        upstream.resourceTemplates.push(entry);
      }
    }

    // Stable ordering for deterministic listings.
    for (const u of Object.values(view)) {
      u.tools.sort((a, b) => a.publicName.localeCompare(b.publicName));
      u.prompts.sort((a, b) => a.publicName.localeCompare(b.publicName));
      u.resources.sort((a, b) => a.publicName.localeCompare(b.publicName));
    }

    const upstreamIdBySlug = new Map<string, string>();
    for (const u of Object.values(view)) upstreamIdBySlug.set(u.slug, u.upstreamId);

    this.snapshot = {
      version: (this.snapshot?.version ?? 0) + 1,
      builtAt: Date.now(),
      upstreams: view,
      toolsByPublicName,
      promptsByPublicName,
      resourcesByPublicUri,
      upstreamIdBySlug,
    };
    this.dirty = false;
    return this.snapshot;
  }

  get(): CatalogSnapshot {
    if (this.dirty) return this.rebuild();
    return this.snapshot;
  }

  getVersion(): number {
    return this.snapshot.version;
  }

  /** Marks the catalog stale and schedules a debounced rebuild + change event. */
  invalidate(reason: string): void {
    this.dirty = true;
    scheduleNotify(this, reason);
  }

  forceNotify(reason: string): void {
    this.dirty = true;
    notifyNow(this, reason);
  }
}

const DEBOUNCE_MS = 500;
let timer: NodeJS.Timeout | null = null;
let pendingReason = "";

function scheduleNotify(store: CatalogStore, reason: string): void {
  pendingReason = reason;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    notifyNow(store, pendingReason);
  }, DEBOUNCE_MS);
  if (typeof timer.unref === "function") timer.unref();
}

function notifyNow(store: CatalogStore, reason: string): void {
  const snap = store.rebuild();
  store.emit("changed", { version: snap.version, reason, at: Date.now() });
}

const CATALOG_KEY = "catalog-store";

/**
 * One catalog per process. The custom server (which owns the upstream manager and the SSE push)
 * and Next's route handlers are separate module graphs, so the store must live on globalThis —
 * otherwise the UI would read a catalog that never receives upstream listings.
 */
export function getCatalog(): CatalogStore {
  return globalSingleton<CatalogStore>(CATALOG_KEY, () => new CatalogStore());
}

/** Test helper. */
export function clearCatalog(): void {
  clearGlobalSingleton(CATALOG_KEY);
}

export function getCatalogSnapshot(): CatalogSnapshot {
  return getCatalog().get();
}

export function invalidateCatalog(reason = "manual"): void {
  getCatalog().invalidate(reason);
}

export function onCatalogChanged(listener: (e: { version: number; reason: string; at: number }) => void): () => void {
  const s = getCatalog();
  s.on("changed", listener);
  return () => s.off("changed", listener);
}

function emptySnapshot(): CatalogSnapshot {
  return {
    version: 0,
    builtAt: 0,
    upstreams: {},
    toolsByPublicName: new Map(),
    promptsByPublicName: new Map(),
    resourcesByPublicUri: new Map(),
    upstreamIdBySlug: new Map(),
  };
}

/** Resolves a public tool/prompt name back to its upstream + original name. */
export function resolvePublicTool(publicName: string) {
  return getCatalogSnapshot().toolsByPublicName.get(publicName) ?? null;
}

export function resolvePublicPrompt(publicName: string) {
  return getCatalogSnapshot().promptsByPublicName.get(publicName) ?? null;
}

export function resolvePublicResource(uri: string) {
  const snap = getCatalogSnapshot();
  return snap.resourcesByPublicUri.get(uri) ?? null;
}

/** Aggregated view for a key: only what it may see. Used by the gateway and the UI preview. */
export function visibleToolsFor(access: { upstreams: Record<string, { tools: string[] }> }): CatalogEntry[] {
  const snap = getCatalogSnapshot();
  const out: CatalogEntry[] = [];
  for (const [upstreamId, entry] of Object.entries(access.upstreams)) {
    const view = snap.upstreams[upstreamId];
    if (!view) continue;
    for (const toolName of entry.tools) {
      const publicName = view.toolPublicNames.get(toolName);
      const found = publicName ? snap.toolsByPublicName.get(publicName) : null;
      if (found) out.push(found.entry);
    }
  }
  return out.sort((a, b) => a.publicName.localeCompare(b.publicName));
}
