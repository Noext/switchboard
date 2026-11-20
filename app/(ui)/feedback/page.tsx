import type { Metadata } from "next";
import Link from "next/link";
import { requireUiAuth } from "@/components/server/auth";
import {
  FEEDBACK_CATEGORIES,
  FEEDBACK_SEVERITIES,
  FEEDBACK_STATUSES,
  feedbackStats,
  listFeedback,
  type FeedbackCategory,
  type FeedbackSeverity,
  type FeedbackStatus,
} from "@/lib/feedback";
import { listKeys } from "@/lib/auth/keys";
import { Card, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui/card";
import { FeedbackListClient } from "./feedback-list";

export const metadata: Metadata = { title: "Retours — Switchboard" };
export const dynamic = "force-dynamic";

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUiAuth();
  const sp = await searchParams;
  const pick = (key: string): string[] => {
    const raw = sp[key];
    if (!raw) return [];
    const value = Array.isArray(raw) ? raw.join(",") : raw;
    return value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
  };

  const statuses = pick("status").filter((s) => (FEEDBACK_STATUSES as readonly string[]).includes(s)) as FeedbackStatus[];
  const categories = pick("category").filter((c) => (FEEDBACK_CATEGORIES as readonly string[]).includes(c)) as FeedbackCategory[];
  const severities = pick("severity").filter((s) => (FEEDBACK_SEVERITIES as readonly string[]).includes(s)) as FeedbackSeverity[];
  const keyId = typeof sp.key === "string" ? sp.key : undefined;
  const upstream = typeof sp.upstream === "string" ? sp.upstream : undefined;
  const tool = typeof sp.tool === "string" ? sp.tool : undefined;
  const search = typeof sp.search === "string" ? sp.search : undefined;
  const offset = Number(typeof sp.offset === "string" ? sp.offset : "0") || 0;

  let items: ReturnType<typeof listFeedback>["items"] = [];
  let total = 0;
  let stats = {
    byStatus: { new: 0, acknowledged: 0, in_progress: 0, resolved: 0, wont_fix: 0 } as Record<FeedbackStatus, number>,
    open: 0,
    openBySeverity: { low: 0, medium: 0, high: 0, blocking: 0 } as Record<FeedbackSeverity, number>,
  };
  let keys: Array<{ id: string; name: string }> = [];
  try {
    const res = listFeedback({
      status: statuses.length ? statuses : undefined,
      category: categories.length ? categories : undefined,
      severity: severities.length ? severities : undefined,
      keyId,
      upstreamSlug: upstream,
      toolName: tool,
      search,
      limit: 50,
      offset,
    });
    items = res.items;
    total = res.total;
    stats = feedbackStats();
    keys = listKeys().map((k) => ({ id: k.id, name: k.name }));
  } catch {
    /* fresh install */
  }

  return (
    <div>
      <PageHeader
        title="Retours des agents"
        description="Signalements envoyés via l'outil report_feedback : problème d'outil, accès manquant, description trompeuse, lenteur."
      />

      <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="Ouverts" value={stats.open} hint={stats.byStatus.new + " nouveaux"} tone={stats.open ? "warn" : "default"} />
        <Stat label="Bloquants" value={stats.openBySeverity.blocking} tone={stats.openBySeverity.blocking ? "bad" : "default"} />
        <Stat label="Gravité haute" value={stats.openBySeverity.high} tone={stats.openBySeverity.high ? "warn" : "default"} />
        <Stat label="Résolus" value={stats.byStatus.resolved} tone="ok" />
      </div>

      <Card>
        <CardHeader title={total + " retour(s)"} subtitle="Filtres cumulables · sélection multiple pour changer le statut en lot" />
        <FeedbackListClient
          items={items.map((i) => ({
            id: i.id,
            createdAt: i.createdAt,
            lastOccurrenceAt: i.lastOccurrenceAt,
            updatedAt: i.updatedAt,
            severity: i.severity,
            category: i.category,
            title: i.title,
            status: i.status,
            keyId: i.keyId,
            keyName: i.keyName,
            upstreamSlug: i.upstreamSlug,
            toolName: i.toolName,
            occurrences: i.occurrences,
            adminNote: i.adminNote,
          }))}
          keys={keys}
          total={total}
          offset={offset}
          activeFilters={{
            status: statuses,
            category: categories,
            severity: severities,
            key: keyId ?? "",
            upstream: upstream ?? "",
            tool: tool ?? "",
            search: search ?? "",
          }}
        />
      </Card>

      {total === 0 && !search && statuses.length === 0 ? (
        <div className="mt-3">
          <Card>
            <EmptyState
              title="Aucun retour pour l'instant"
              description="Les agents voient l'outil report_feedback quel que soit leurs droits (sauf s'il est désactivé dans les Paramètres). Un retour apparaît ici avec la clé, la session et l'appel en erreur lié."
              action={
                <Link href="/settings" className="btn btn-secondary btn-sm">
                  Paramètres des retours
                </Link>
              }
            />
          </Card>
        </div>
      ) : null}
    </div>
  );
}
