import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { itemOverrides } from "../db/schema";
import { invalidateCatalog } from "./catalog";
import type { ItemKind } from "../types";

export function setOverride(
  upstreamId: string,
  kind: ItemKind,
  name: string,
  patch: { enabled?: boolean; alias?: string | null; descriptionOverride?: string | null },
): void {
  const db = getDb();
  const existing = db
    .select()
    .from(itemOverrides)
    .where(and(eq(itemOverrides.upstreamId, upstreamId), eq(itemOverrides.kind, kind), eq(itemOverrides.name, name)))
    .get();

  if (existing) {
    db.update(itemOverrides)
      .set({
        enabled: patch.enabled ?? existing.enabled,
        alias: patch.alias !== undefined ? patch.alias : existing.alias,
        descriptionOverride:
          patch.descriptionOverride !== undefined ? patch.descriptionOverride : existing.descriptionOverride,
      })
      .where(
        and(eq(itemOverrides.upstreamId, upstreamId), eq(itemOverrides.kind, kind), eq(itemOverrides.name, name)),
      )
      .run();
  } else {
    db.insert(itemOverrides)
      .values({
        upstreamId,
        kind,
        name,
        enabled: patch.enabled ?? true,
        alias: patch.alias ?? null,
        descriptionOverride: patch.descriptionOverride ?? null,
      })
      .run();
  }
  invalidateCatalog("override");
}

export function getOverrides(upstreamId: string) {
  return getDb().select().from(itemOverrides).where(eq(itemOverrides.upstreamId, upstreamId)).all();
}

export function getOverride(upstreamId: string, kind: ItemKind, name: string) {
  return (
    getDb()
      .select()
      .from(itemOverrides)
      .where(and(eq(itemOverrides.upstreamId, upstreamId), eq(itemOverrides.kind, kind), eq(itemOverrides.name, name)))
      .get() ?? null
  );
}

export function resetOverride(upstreamId: string, kind: ItemKind, name: string): void {
  getDb()
    .delete(itemOverrides)
    .where(and(eq(itemOverrides.upstreamId, upstreamId), eq(itemOverrides.kind, kind), eq(itemOverrides.name, name)))
    .run();
  invalidateCatalog("override-reset");
}
