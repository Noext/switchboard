import type { Metadata } from "next";
import Link from "next/link";
import { requireUiAuth } from "@/components/server/auth";
import {
  callStats,
  dashboardFeedback,
  keysWithoutAccess,
  listUpstreamRows,
  newDiscoveries,
  recentErrors,
  upstreamStatusCounts,
} from "@/components/server/data";
import { listKeys } from "@/lib/auth/keys";
import { listRoles } from "@/lib/auth/grants";
import { Badge, CountBadge, FeedbackStatusBadge, SeverityBadge, StatusBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR, TableWrap, EmptyRow } from "@/components/ui/table";
import { Callout } from "@/components/ui/misc";
import { relTime, duration, num } from "@/components/format";
import { GrantDiscoveryActions, LiveSessions, OAuthReconnectButton } from "./dashboard-widgets";

export const metadata: Metadata = { title: "Dashboard — Switchboard" };
export const dynamic = "force-dynamic";

const statusOrder = ["ready", "connecting", "degraded", "auth_required", "error", "disabled"] as const;

export default async function DashboardPage() {
  await requireUiAuth();

  let upstreams: ReturnType<typeof listUpstreamRows> = [];
  let keys: ReturnType<typeof listKeys> = [];
  let roles: ReturnType<typeof listRoles> = [];
  let stats = { calls24h: 0, denied24h: 0, errors24h: 0, calls7d: 0, denied7d: 0 };
  let fb = { open: 0, bySeverity: { blocking: 0, high: 0, medium: 0, low: 0 }, latest: [] as ReturnType<typeof dashboardFeedback>["latest"] };
  let discoveries: ReturnType<typeof newDiscoveries> = [];
  let errors: ReturnType<typeof recentErrors> = [];
  let statusCounts: ReturnType<typeof upstreamStatusCounts> = [];
  let orphanKeys: ReturnType<typeof keysWithoutAccess> = [];

  try {
    upstreams = listUpstreamRows();
    keys = listKeys();
    roles = listRoles();
    stats = callStats();
    fb = dashboardFeedback();
    discoveries = newDiscoveries();
    errors = recentErrors(8);
    statusCounts = upstreamStatusCounts();
    orphanKeys = keysWithoutAccess();
  } catch {
    /* fresh install before migrations: render the empty state instead of crashing */
  }

  const now = Date.now();
  const activeKeys = keys.filter((k) => !k.revokedAt && (!k.expiresAt || k.expiresAt > now));
  const authRequired = upstreams.filter((u) => u.status === "auth_required");
  const readyCount = upstreams.filter((u) => u.status === "ready").length;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Vue d'ensemble de la passerelle : santé des MCP, clés et sessions, trafic, retours des agents."
        actions={
          <>
            <Link href="/servers/new" className="btn btn-secondary btn-sm">
              Ajouter un MCP
            </Link>
            <Link href="/keys/new" className="btn btn-primary btn-sm">
              Créer une clé
            </Link>
          </>
        }
      />

      {authRequired.length > 0 ? (
        <div className="mb-3 flex flex-col gap-2">
          {authRequired.map((u) => (
            <Callout
              key={u.id}
              tone="warn"
              title={"Reconnexion OAuth requise — " + u.name + " (" + u.slug + ")"}
              action={<OAuthReconnectButton upstreamId={u.id} />}
            >
              Le serveur a perdu son autorisation. Ses outils sont retirés du catalogue jusqu'à la reconnexion.
              {u.lastError ? <span className="ml-1 mono text-[11px]">({u.lastError})</span> : null}
            </Callout>
          ))}
        </div>
      ) : null}

      {discoveries.length > 0 ? (
        <div className="mb-3">
          <Card>
            <CardHeader
              title={"Nouveaux outils détectés (" + discoveries.length + ")"}
              subtitle="Accordés automatiquement aux sujets en mode « tous les outils ». En attente pour les sélections."
            />
            <div className="divide-line">
              {discoveries.slice(0, 8).map((d) => (
                <div key={d.upstreamId + ":" + d.toolName} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2">
                  <div className="min-w-0">
                    <span className="mono text-[12px] text-ink">
                      {d.upstreamSlug ?? "?"}__{d.toolName}
                    </span>
                    <span className="ml-2 text-[11.5px] text-muted">
                      {d.upstreamName ?? d.upstreamId} · détecté {relTime(d.firstSeenAt)}
                    </span>
                  </div>
                  <GrantDiscoveryActions upstreamId={d.upstreamId} toolName={d.toolName} upstreamSlug={d.upstreamSlug} />
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : null}

      <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="MCP prêts" value={readyCount} hint={upstreams.length + " configuré(s)"} tone={readyCount ? "ok" : "default"} />
        <Stat label="MCP en erreur" value={upstreams.filter((u) => u.status === "error" || u.status === "degraded").length} hint="dont dégradés" tone="warn" />
        <Stat label="Clés actives" value={activeKeys.length} hint={keys.length + " au total"} />
        <Stat label="Appels / 24 h" value={num(stats.calls24h)} hint={num(stats.calls7d) + " sur 7 j"} />
        <Stat label="Refus / 24 h" value={num(stats.denied24h)} hint="droits insuffisants" tone={stats.denied24h ? "warn" : "default"} />
        <Stat label="Retours ouverts" value={num(fb.open)} hint={fb.bySeverity.blocking + " bloquant(s)"} tone={fb.bySeverity.blocking ? "bad" : "default"} />
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.35fr_1fr]">
        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader
              title="MCP par statut"
              actions={
                <Link href="/servers" className="btn btn-ghost btn-xs">
                  Tout voir
                </Link>
              }
            />
            <CardBody className="pt-2.5">
              <div className="mb-3 flex flex-wrap gap-1.5">
                {statusCounts
                  .filter((s) => s.count > 0)
                  .map((s) => (
                    <span key={s.status} className="pill">
                      <span className={"status-dot dot-" + s.status} />
                      {s.status}
                      <b className="text-ink">{s.count}</b>
                    </span>
                  ))}
                {upstreams.length === 0 ? <span className="text-[12px] text-muted">Aucun serveur configuré.</span> : null}
              </div>
              <TableWrap>
                <Table>
                  <THead>
                    <TR>
                      <TH>Slug</TH>
                      <TH>Nom</TH>
                      <TH>Statut</TH>
                      <TH className="text-right">Outils</TH>
                      <TH className="text-right">p50</TH>
                      <TH className="text-right">Appels 24 h</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {upstreams.length === 0 ? (
                      <EmptyRow colSpan={6}>
                        <Link href="/servers/new" className="link">
                          Ajouter votre premier serveur MCP
                        </Link>
                      </EmptyRow>
                    ) : (
                      upstreams.slice(0, 12).map((u) => (
                        <TR key={u.id}>
                          <TD>
                            <Link href={"/servers/" + u.id} className="mono link">
                              {u.slug}
                            </Link>
                          </TD>
                          <TD className="max-w-[220px] truncate" title={u.name}>
                            {u.name}
                          </TD>
                          <TD>
                            <StatusBadge status={u.enabled ? u.status : "disabled"} />
                          </TD>
                          <TD className="text-right tabular-nums">{u.toolCount}</TD>
                          <TD className="text-right tabular-nums text-muted">{duration(u.p50Latency)}</TD>
                          <TD className="text-right tabular-nums text-muted">
                            {u.callCount24h}
                            {u.errorCount24h > 0 ? <span className="ml-1 text-bad">({u.errorCount24h})</span> : null}
                          </TD>
                        </TR>
                      ))
                    )}
                  </TBody>
                </Table>
              </TableWrap>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Erreurs récentes"
              actions={
                <Link href="/logs?outcome=error" className="btn btn-ghost btn-xs">
                  Journal
                </Link>
              }
            />
            <CardBody className="pt-2.5">
              {errors.length === 0 ? (
                <p className="text-[12px] text-muted">Aucune erreur enregistrée. </p>
              ) : (
                <div className="divide-line">
                  {errors.map((c) => (
                    <div key={c.id} className="flex items-start justify-between gap-3 py-1.5">
                      <div className="min-w-0">
                        <div className="truncate mono text-[11.5px]">
                          <span className="text-muted">{c.upstreamSlug ?? "—"} ·</span> {c.name}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-muted" title={c.resultPreview ?? ""}>
                          {c.errorCode ? c.errorCode + " — " : ""}
                          {c.resultPreview ?? "sans détail"}
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-[11px] text-muted">
                        <div>{relTime(c.at)}</div>
                        <div className="truncate">{c.keyName ?? "—"}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>

        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader title="Clés et sessions" actions={<Link href="/keys" className="btn btn-ghost btn-xs">Gérer</Link>} />
            <CardBody className="pt-2.5">
              <LiveSessions />
              <div className="mt-2.5 divide-line">
                {keys.length === 0 ? (
                  <p className="text-[12px] text-muted">
                    Aucune clé.{" "}
                    <Link href="/keys/new" className="link">
                      Créer une clé
                    </Link>
                  </p>
                ) : (
                  keys.slice(0, 7).map((k) => (
                    <div key={k.id} className="flex items-center justify-between gap-2 py-1.5">
                      <div className="min-w-0">
                        <Link href={"/keys/" + k.id} className="truncate text-[12px] text-ink hover:underline">
                          {k.name}
                        </Link>
                        <span className="ml-1.5 mono text-[10.5px] text-muted">{k.prefix}…</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {k.roleIds.length > 0 ? <Badge tone="violet">{k.roleIds.length} rôle(s)</Badge> : null}
                        <span className="text-[11px] text-muted">{relTime(k.lastUsedAt)}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
              {orphanKeys.length > 0 ? (
                <div className="mt-2">
                  <Callout tone="info" title={orphanKeys.length + " clé(s) sans aucun droit"}>
                    {orphanKeys.map((k) => k.name).join(", ")} — ces agents ne voient aucun outil.
                  </Callout>
                </div>
              ) : null}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Retours non traités"
              actions={<Link href="/feedback" className="btn btn-ghost btn-xs">Tous les retours</Link>}
            />
            <CardBody className="pt-2.5">
              <div className="mb-2 flex flex-wrap gap-1.5">
                <Badge tone="bad">{fb.bySeverity.blocking} bloquants</Badge>
                <Badge tone="warn">{fb.bySeverity.high} hauts</Badge>
                <Badge tone="info">{fb.bySeverity.medium} moyens</Badge>
                <Badge tone="neutral">{fb.bySeverity.low} bas</Badge>
              </div>
              {fb.latest.length === 0 ? (
                <p className="text-[12px] text-muted">Aucun retour ouvert. Les agents peuvent signaler un problème avec report_feedback.</p>
              ) : (
                <div className="divide-line">
                  {fb.latest.map((f) => (
                    <Link key={f.id} href={"/feedback/" + f.id} className="block py-1.5 hover:bg-[hsla(0,0%,100%,0.03)]">
                      <div className="flex items-start justify-between gap-2">
                        <span className="min-w-0 truncate text-[12px] text-ink">{f.title}</span>
                        <SeverityBadge severity={f.severity} />
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                        <FeedbackStatusBadge status={f.status} />
                        <span className="truncate">{f.keyName ?? f.keyId.slice(0, 8)}</span>
                        <span>·</span>
                        <span>{relTime(f.lastOccurrenceAt)}</span>
                        {f.occurrences > 1 ? <CountBadge count={f.occurrences} tone="bad" /> : null}
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Rôles" actions={<Link href="/roles" className="btn btn-ghost btn-xs">Gérer</Link>} />
            <CardBody className="pt-2.5">
              {roles.length === 0 ? (
                <p className="text-[12px] text-muted">Aucun rôle. Les rôles regroupent des droits réutilisables entre clés.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {roles.map((r) => (
                    <Link key={r.id} href={"/roles/" + r.id} className="pill hover:text-ink">
                      {r.name}
                      <b className="text-ink">{r.keyIds.length}</b>
                    </Link>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        </div>
      </div>

      {upstreams.length === 0 && keys.length === 0 ? (
        <Card className="mt-3">
          <EmptyState
            title="Installation neuve"
            description="Ajoutez un serveur MCP puis créez une clé API : chaque agent se connectera à Switchboard avec sa propre clé et ne verra que les outils autorisés."
            action={
              <div className="flex gap-2">
                <Link href="/servers/new" className="btn btn-primary btn-sm">
                  Ajouter un MCP
                </Link>
                <Link href="/import" className="btn btn-secondary btn-sm">
                  Importer une config existante
                </Link>
              </div>
            }
          />
        </Card>
      ) : null}
    </div>
  );
}
