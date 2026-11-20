import type { Metadata } from "next";
import Link from "next/link";
import { requireUiAuth } from "@/components/server/auth";
import { listCallLogs, listUpstreamRows } from "@/components/server/data";
import { listKeys } from "@/lib/auth/keys";
import { Card, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui/card";
import { LogsTable } from "./logs-table";

export const metadata: Metadata = { title: "Journal — Switchboard" };
export const dynamic = "force-dynamic";

export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUiAuth();
  const sp = await searchParams;
  const str = (k: string): string | undefined => {
    const v = sp[k];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };

  const outcome = (str("outcome") ?? "all") as "all" | "ok" | "error" | "denied";
  const keyId = str("key");
  const upstreamId = str("upstream");
  const name = str("name");
  const kind = str("kind");
  const sinceHours = Number(str("since") ?? "0") || 0;
  const offset = Number(str("offset") ?? "0") || 0;

  let items: ReturnType<typeof listCallLogs>["items"] = [];
  let total = 0;
  let keys: Array<{ id: string; name: string }> = [];
  let upstreams: ReturnType<typeof listUpstreamRows> = [];

  try {
    const res = listCallLogs({
      keyId,
      upstreamId,
      name,
      kind: kind && kind !== "all" ? kind : undefined,
      outcome,
      sinceHours,
      limit: 100,
      offset,
    });
    items = res.items;
    total = res.total;
    keys = listKeys().map((k) => ({ id: k.id, name: k.name }));
    upstreams = listUpstreamRows();
  } catch {
    /* fresh install */
  }

  const denied = items.filter((i) => i.denied).length;
  const errors = items.filter((i) => !i.ok && !i.denied).length;

  return (
    <div>
      <PageHeader
        title="Journal des appels"
        description="Chaque appel d'outil est enregistré (aperçus tronqués à 2 Ko, secrets masqués). Rétention : 30 jours ou 100 000 lignes."
      />

      <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="Résultats" value={total} hint="avec les filtres actifs" />
        <Stat label="Sur cette page" value={items.length} />
        <Stat label="Refus" value={denied} tone={denied ? "warn" : "default"} hint="droits insuffisants" />
        <Stat label="Erreurs" value={errors} tone={errors ? "bad" : "default"} hint="hors refus" />
      </div>

      <Card>
        <CardHeader title="Appels" subtitle="Cliquez sur une ligne pour voir le détail complet." />
        <LogsTable
          items={items}
          total={total}
          offset={offset}
          keys={keys}
          upstreams={upstreams.map((u) => ({ id: u.id, slug: u.slug, name: u.name }))}
          filters={{ outcome, key: keyId ?? "", upstream: upstreamId ?? "", name: name ?? "", kind: kind ?? "all", since: String(sinceHours) }}
        />
      </Card>

      {total === 0 && keys.length === 0 ? (
        <div className="mt-3">
          <Card>
            <EmptyState
              title="Aucun appel enregistré"
              description="Dès qu'un agent utilisera une clé pour appeler un outil via /mcp, l'appel apparaîtra ici avec son résultat et sa durée."
              action={
                <Link href="/servers" className="btn btn-secondary btn-sm">
                  Voir les serveurs
                </Link>
              }
            />
          </Card>
        </div>
      ) : null}
    </div>
  );
}
