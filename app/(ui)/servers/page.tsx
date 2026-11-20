import type { Metadata } from "next";
import Link from "next/link";
import { requireUiAuth } from "@/components/server/auth";
import { listUpstreamRows } from "@/components/server/data";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR, TableWrap, EmptyRow } from "@/components/ui/table";
import { duration, relTime } from "@/components/format";

export const metadata: Metadata = { title: "Serveurs — Switchboard" };
export const dynamic = "force-dynamic";

const transportLabel: Record<string, string> = { http: "HTTP", sse: "SSE", stdio: "stdio" };

export default async function ServersPage() {
  await requireUiAuth();

  let rows: ReturnType<typeof listUpstreamRows> = [];
  try {
    rows = listUpstreamRows();
  } catch {
    rows = [];
  }

  const ready = rows.filter((r) => r.status === "ready").length;

  return (
    <div>
      <PageHeader
        title="Serveurs MCP"
        description="Les serveurs amont agrégés par la passerelle. Un serveur en panne n'affecte pas les autres."
        actions={
          <Link href="/servers/new" className="btn btn-primary btn-sm">
            Ajouter un serveur
          </Link>
        }
      />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            title="Aucun serveur MCP configuré"
            description="Ajoutez un MCP distant (streamable HTTP / SSE) ou un MCP local (stdio, npx/uvx/docker). Vous pouvez aussi importer une configuration existante."
            action={
              <div className="flex gap-2">
                <Link href="/servers/new" className="btn btn-primary btn-sm">
                  Ajouter un serveur
                </Link>
                <Link href="/import" className="btn btn-secondary btn-sm">
                  Importer
                </Link>
              </div>
            }
          />
        </Card>
      ) : (
        <Card>
          <CardHeader
            title={rows.length + " serveur(s)"}
            subtitle={ready + " prêt(s) · " + (rows.length - ready) + " à surveiller"}
          />
          <TableWrap>
            <Table zebra>
              <THead>
                <TR>
                  <TH>Slug</TH>
                  <TH>Nom</TH>
                  <TH>Transport</TH>
                  <TH>Statut</TH>
                  <TH className="text-right">Outils</TH>
                  <TH className="text-right">Prompts</TH>
                  <TH className="text-right">Ress.</TH>
                  <TH className="text-right">Clés</TH>
                  <TH className="text-right">Rôles</TH>
                  <TH className="text-right">p50 24 h</TH>
                  <TH className="text-right">Appels 24 h</TH>
                  <TH>Dernière erreur</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((u) => (
                  <TR key={u.id}>
                    <TD>
                      <Link href={"/servers/" + u.id} className="mono link font-medium">
                        {u.slug}
                      </Link>
                      {!u.enabled ? <Badge tone="neutral" className="ml-1.5">off</Badge> : null}
                    </TD>
                    <TD className="max-w-[240px] truncate" title={u.name}>
                      {u.name}
                    </TD>
                    <TD>
                      <span className="pill">{transportLabel[u.transport] ?? u.transport}</span>
                      {u.authType !== "none" ? <Badge tone="info" className="ml-1">{u.authType}</Badge> : null}
                    </TD>
                    <TD>
                      <StatusBadge status={u.enabled ? u.status : "disabled"} />
                      {u.lastReadyAt ? <div className="mt-0.5 text-[10.5px] text-muted">prêt {relTime(u.lastReadyAt)}</div> : null}
                    </TD>
                    <TD className="text-right tabular-nums">{u.toolCount}</TD>
                    <TD className="text-right tabular-nums text-muted">{u.promptCount}</TD>
                    <TD className="text-right tabular-nums text-muted">{u.resourceCount}</TD>
                    <TD className="text-right tabular-nums">{u.keyAccessCount}</TD>
                    <TD className="text-right tabular-nums text-muted">{u.roleAccessCount}</TD>
                    <TD className="text-right tabular-nums text-muted">{duration(u.p50Latency)}</TD>
                    <TD className="text-right tabular-nums text-muted">
                      {u.callCount24h}
                      {u.errorCount24h > 0 ? <span className="ml-1 text-bad">({u.errorCount24h})</span> : null}
                    </TD>
                    <TD className="max-w-[220px] truncate text-[11px] text-muted" title={u.lastError ?? ""}>
                      {u.lastError ?? "—"}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </TableWrap>
        </Card>
      )}
    </div>
  );
}
