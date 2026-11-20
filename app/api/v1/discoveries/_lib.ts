import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  apiKeys,
  grantTools,
  grants,
  roles,
  toolDiscoveries,
  upstreams,
} from "@/lib/db/schema";
import { upsertGrant } from "@/lib/auth/grants";
import { emitUiEvent } from "@/lib/events";
import { logEvent } from "@/lib/logs";
import { invalidateCatalog } from "@/lib/catalog/catalog";
import { getCatalogSnapshot } from "@/lib/catalog/catalog";

/**
 * Helpers behind `app/api/v1/discoveries/**` (spec §7.4 "Ajout d'un MCP et nouveaux outils"),
 * kept next to the routes because no other module owns `tool_discoveries`.
 *
 * A discovery row only says "upstream U published tool T at time X". Who gets it *now* is derived
 * from the existing grants: subjects in `all` mode already have it (and cannot be excluded by a
 * `selected` grant on the same upstream), `selected` subjects need it added explicitly.
 */

export interface DiscoveryGap {
  subjectType: "role" | "key";
  subjectId: string;
  label: string;
  grantId: string;
  /** Tools the subject already has on this upstream (for the pre-filled checkbox list). */
  tools: string[];
}

export interface DiscoveryRow {
  upstreamId: string;
  upstreamSlug: string;
  upstreamName: string;
  toolName: string;
  /** Public name as exposed to clients (`<slug>__<tool>`). */
  publicName: string;
  firstSeenAt: number;
  acknowledgedAt: number | null;
  /** True when the upstream is currently publishable (ready/connecting): a hint, not a rule. */
  upstreamEnabled: boolean;
  /** Subjects in `all` mode: they already have the tool. */
  autoGranted: Array<{ subjectType: "role" | "key"; subjectId: string; label: string }>;
  /** Subjects in `selected` mode that do not have the tool yet. */
  pending: DiscoveryGap[];
}

export function listDiscoveries(options: { includeAcknowledged?: boolean; upstreamId?: string } = {}): DiscoveryRow[] {
  const db = getDb();
  const rows = db
    .select()
    .from(toolDiscoveries)
    .orderBy(desc(toolDiscoveries.firstSeenAt))
    .all()
    .filter((row) => options.includeAcknowledged || row.acknowledgedAt === null)
    .filter((row) => options.upstreamId === undefined || row.upstreamId === options.upstreamId);

  if (rows.length === 0) return [];

  const snapshot = getCatalogSnapshot();
  const upRows = db.select().from(upstreams).all();
  const upstreamById = new Map(upRows.map((u) => [u.id, u]));
  const grantRows = db.select().from(grants).all();
  const toolRows = db.select().from(grantTools).all();
  const roleRows = db.select().from(roles).all();
  const keyRows = db.select().from(apiKeys).all();
  const roleName = new Map(roleRows.map((r) => [r.id, r.name]));
  const keyName = new Map(keyRows.map((k) => [k.id, k.name]));
  const toolsByGrant = new Map<string, string[]>();
  for (const t of toolRows) {
    const list = toolsByGrant.get(t.grantId) ?? [];
    list.push(t.toolName);
    toolsByGrant.set(t.grantId, list);
  }

  const label = (subjectType: "role" | "key", subjectId: string): string =>
    subjectType === "role" ? (roleName.get(subjectId) ?? subjectId) : (keyName.get(subjectId) ?? subjectId);

  const out: DiscoveryRow[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const upstream = upstreamById.get(row.upstreamId);
    if (!upstream) continue;
    const key = `${row.upstreamId}||${row.toolName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const upstreamGrants = grantRows.filter((g) => g.upstreamId === row.upstreamId);
    const autoGranted: DiscoveryRow["autoGranted"] = [];
    const pending: DiscoveryGap[] = [];

    // A subject granted in "all" mode already has the tool; do not list it as pending even when
    // that subject also holds a "selected" grant on the same upstream (all wins, §7.3).
    const allModeSubjects = new Set(
      upstreamGrants
        .filter((g) => g.toolMode === "all")
        .map((g) => `${g.subjectType}:${g.subjectId}`),
    );

    for (const grant of upstreamGrants) {
      const subjectKey = `${grant.subjectType}:${grant.subjectId}`;
      if (grant.toolMode === "all") {
        autoGranted.push({
          subjectType: grant.subjectType,
          subjectId: grant.subjectId,
          label: label(grant.subjectType, grant.subjectId),
        });
        continue;
      }
      if (allModeSubjects.has(subjectKey)) continue;
      const tools = toolsByGrant.get(grant.id) ?? [];
      if (tools.includes(row.toolName)) continue;
      pending.push({
        subjectType: grant.subjectType,
        subjectId: grant.subjectId,
        label: label(grant.subjectType, grant.subjectId),
        grantId: grant.id,
        tools: tools.slice().sort(),
      });
    }

    pending.sort((a, b) => a.label.localeCompare(b.label));
    autoGranted.sort((a, b) => a.label.localeCompare(b.label));

    // The catalog is authoritative for public names (aliases and truncation included).
    const publicName =
      snapshot.upstreams[row.upstreamId]?.toolPublicNames.get(row.toolName) ?? `${upstream.slug}__${row.toolName}`;

    out.push({
      upstreamId: row.upstreamId,
      upstreamSlug: upstream.slug,
      upstreamName: upstream.name,
      toolName: row.toolName,
      publicName,
      firstSeenAt: row.firstSeenAt,
      acknowledgedAt: row.acknowledgedAt,
      upstreamEnabled: upstream.enabled && (upstream.status === "ready" || upstream.status === "connecting"),
      autoGranted,
      pending,
    });
  }

  return out;
}

/** Number of unacknowledged discoveries (dashboard badge, spec §7.4/§8). */
export function pendingDiscoveryCount(): number {
  try {
    const db = getDb();
    return db.select().from(toolDiscoveries).where(isNull(toolDiscoveries.acknowledgedAt)).all().length;
  } catch {
    return 0;
  }
}

export interface GrantToolResult {
  upstreamId: string;
  toolName: string;
  granted: Array<{ subjectType: "role" | "key"; subjectId: string; grantId: string; created: boolean }>;
  skipped: Array<{ subjectType: "role" | "key"; subjectId: string; reason: string }>;
}

/**
 * Grants one tool to the given subjects (spec §7.4 "accorder à…").
 *
 * - subject already in `all` mode → nothing to do (it has every tool, including future ones);
 * - subject in `selected` mode      → the tool is appended to its grant;
 * - subject with no grant            → a `selected` grant is created holding just that tool.
 */
export function grantToolToSubjects(
  upstreamId: string,
  toolName: string,
  subjects: Array<{ subjectType: "role" | "key"; subjectId: string }>,
  actor = "ui",
): GrantToolResult {
  const db = getDb();
  const granted: GrantToolResult["granted"] = [];
  const skipped: GrantToolResult["skipped"] = [];

  for (const subject of subjects) {
    const existing = db
      .select()
      .from(grants)
      .where(
        and(
          eq(grants.subjectType, subject.subjectType),
          eq(grants.subjectId, subject.subjectId),
          eq(grants.upstreamId, upstreamId),
        ),
      )
      .get();

    if (existing && existing.toolMode === "all") {
      skipped.push({ ...subject, reason: "Already has access to every tool (mode all)." });
      continue;
    }

    if (existing) {
      db.insert(grantTools).values({ grantId: existing.id, toolName }).onConflictDoNothing().run();
      db.update(grants).set({ updatedAt: Date.now() }).where(eq(grants.id, existing.id)).run();
      logEvent({
        actor,
        type: "grant.tool_added",
        message: `Tool "${toolName}" added to ${subject.subjectType} "${subject.subjectId}"`,
        upstreamId,
        data: { ...subject, upstreamId, toolName, grantId: existing.id },
      });
      granted.push({ ...subject, grantId: existing.id, created: false });
      continue;
    }

    const { id } = upsertGrant(
      {
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        upstreamId,
        toolMode: "selected",
        tools: [toolName],
        prompts: false,
        resources: false,
      },
      actor,
    );
    logEvent({
      actor,
      type: "grant.created_from_discovery",
      message: `Selected grant created for ${subject.subjectType} "${subject.subjectId}" with tool "${toolName}"`,
      upstreamId,
      data: { ...subject, upstreamId, toolName, grantId: id },
    });
    granted.push({ ...subject, grantId: id, created: true });
  }

  if (granted.length > 0) {
    invalidateCatalog("discovery.grant");
    emitUiEvent("grant.changed", { upstreamId, toolName, subjects: granted });
  }
  return { upstreamId, toolName, granted, skipped };
}

export interface AckResult {
  acknowledged: number;
  items: Array<{ upstreamId: string; toolName: string; acknowledgedAt: number }>;
}

/** Marks discoveries as seen (spec §7.4 "ignorer"). */
export function acknowledgeDiscoveries(
  items: Array<{ upstreamId: string; toolName?: string | null }>,
  actor = "ui",
): AckResult {
  const db = getDb();
  const now = Date.now();
  const acknowledged: AckResult["items"] = [];

  for (const item of items) {
    const rows = db
      .select()
      .from(toolDiscoveries)
      .where(
        item.toolName
          ? and(eq(toolDiscoveries.upstreamId, item.upstreamId), eq(toolDiscoveries.toolName, item.toolName))
          : eq(toolDiscoveries.upstreamId, item.upstreamId),
      )
      .all();
    for (const row of rows) {
      if (row.acknowledgedAt !== null) continue;
      db.update(toolDiscoveries)
        .set({ acknowledgedAt: now })
        .where(and(eq(toolDiscoveries.upstreamId, row.upstreamId), eq(toolDiscoveries.toolName, row.toolName)))
        .run();
      acknowledged.push({ upstreamId: row.upstreamId, toolName: row.toolName, acknowledgedAt: now });
    }
  }

  if (acknowledged.length > 0) {
    logEvent({
      actor,
      type: "discovery.acknowledged",
      message: `${acknowledged.length} discovery(ies) acknowledged`,
      data: { items: acknowledged },
    });
    emitUiEvent("discovery.new", { acknowledged });
  }
  return { acknowledged: acknowledged.length, items: acknowledged };
}