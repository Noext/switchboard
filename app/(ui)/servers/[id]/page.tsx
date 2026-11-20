import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUiAuth } from "@/components/server/auth";
import {
  catalogItemsFor,
  getUpstreamRow,
  listCallLogs,
  listEvents,
  runtimeStateFor,
  stderrFor,
} from "@/components/server/data";
import { editorData, grantsForSubject, subjectChoices } from "@/components/server/access-data";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR, TableWrap, EmptyRow } from "@/components/ui/table";
import { TabNav } from "@/components/ui/tabs";
import { Callout, Code, Mono } from "@/components/ui/misc";
import { duration, relTime, absTime } from "@/components/format";
import { AccessEditor } from "@/components/access/access-editor";
import { ItemOverridesPanel } from "./item-overrides";
import { ServerActions, TestConsole, StderrPanel, OAuthPanel, AccessSection } from "./server-tabs";

export const metadata: Metadata = { title: "Serveur — Switchboard" };
export const dynamic = "force-dynamic";

const TABS = [
  { id: "tools", label: "Outils" },
  { id: "prompts", label: "Prompts" },
  { id: "resources", label: "Ressources" },
  { id: "access", label: "Accès" },
  { id: "console", label: "Console" },
  { id: "stderr", label: "stderr" },
  { id: "logs", label: "Journal" },
  { id: "oauth", label: "OAuth" },
];

export default async function ServerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; tool?: string }>;
}) {
  await requireUiAuth();
  const { id } = await params;
  const { tab: tabParam, tool: toolParam } = await searchParams;
  const activeTab = TABS.some((t) => t.id === tabParam) ? (tabParam as string) : "tools";

  let row: ReturnType<typeof getUpstreamRow> = null;
  try {
    row = getUpstreamRow(id);
  } catch {
    row = null;
  }
  if (!row) notFound();

  let items: ReturnType<typeof catalogItemsFor> = [];
  let runtime: ReturnType<typeof runtimeStateFor> = null;
  let stderr: string[] = [];
  let logs: ReturnType<typeof listCallLogs> = { items: [], total: 0 };
  let events: ReturnType<typeof listEvents> = [];
  let editor: ReturnType<typeof editorData> = { upstreams: [] };
  let choices: ReturnType<typeof subjectChoices> = { keys: [], roles: [] };
  let upstreamGrants: Array<{ subjectType: "key" | "role"; subjectId: string; toolMode: "all" | "selected"; tools: string[] }> = [];

  try {
    items = catalogItemsFor(id);
    runtime = runtimeStateFor(id);
    stderr = stderrFor(id);
    logs = listCallLogs({ upstreamId: id, limit: 50 });
    events = listEvents({ upstreamId: id, limit: 50 });
    editor = editorData();
    choices = subjectChoices();
    // Raw grants of this upstream, flattened for the editor.
    const { getDb } = await import("@/lib/db");
    const { grants, grantTools } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = getDb();
    const rows = db.select().from(grants).where(eq(grants.upstreamId, id)).all();
    const toolRows = db.select().from(grantTools).all();
    upstreamGrants = rows.map((g) => ({
      subjectType: g.subjectType as "key" | "role",
      subjectId: g.subjectId,
      toolMode: g.toolMode as "all" | "selected",
      tools: toolRows.filter((t) => t.grantId === g.id).map((t) => t.toolName).sort(),
    }));
  } catch {
    /* keep empty states */
  }

  const tools = items.filter((i) => i.kind === "tool");
  const prompts = items.filter((i) => i.kind === "prompt");
  const resources = items.filter((i) => i.kind === "resource" || i.kind === "resource_template");

  return (
    <div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span className="mono">{row.slug}</span>
            <span className="text-muted">·</span>
            {row.name}
            <StatusBadge status={row.enabled ? row.status : "disabled"} />
          </span>
        }
        description={row.description ?? undefined}
        breadcrumb={
          <span>
            <Link href="/servers" className="link">
              Serveurs
            </Link>{" "}
            / <span className="mono">{row.slug}</span>
          </span>
        }
        actions={
          <ServerActions
            upstreamId={row.id}
            enabled={row.enabled}
            authType={row.authType}
            name={row.name}
            oauthStatus={row.status}
          />
        }
      />

      {row.lastError ? (
        <div className="mb-3">
          <Callout tone={row.status === "error" ? "bad" : "warn"} title={"Dernière erreur — " + row.status}>
            <span className="mono text-[11.5px]">{row.lastError}</span>
          </Callout>
        </div>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Outils" value={row.toolCount} hint={row.promptCount + " prompts · " + row.resourceCount + " ressources"} />
        <Stat label="Transport" value={row.transport.toUpperCase()} hint={row.transport === "stdio" ? row.startMode : row.authType} />
        <Stat label="Clés avec accès" value={row.keyAccessCount} hint={row.roleAccessCount + " rôle(s)"} />
        <Stat label="p50 24 h" value={duration(row.p50Latency)} hint={row.callCount24h + " appels"} />
        <Stat label="Erreurs 24 h" value={row.errorCount24h} tone={row.errorCount24h ? "bad" : "default"} />
        <Stat label="Prêt depuis" value={row.lastReadyAt ? relTime(row.lastReadyAt) : "—"} hint={runtime?.serverInfo?.name ?? undefined} />
      </div>

      <Card className="mb-3">
        <CardBody className="py-2.5">
          <dl className="kv">
            <dt>Endpoint</dt>
            <dd className="mono text-[11.5px]">{row.transport === "stdio" ? (row.command ?? "—") + " " + (row.args ?? []).join(" ") : row.url ?? "—"}</dd>
            <dt>Auth amont</dt>
            <dd>
              {row.authType}
              {row.authType === "oauth" ? <span className="ml-2 text-[11px] text-muted">les tokens sont chiffrés ; reconnexion via l&apos;onglet OAuth</span> : null}
            </dd>
            <dt>Timeout</dt>
            <dd>{row.callTimeoutSeconds} s</dd>
            {row.transport === "stdio" ? (
              <>
                <dt>Mode</dt>
                <dd>
                  {row.startMode} · arrêt après {row.idleStopMinutes} min d&apos;inactivité
                </dd>
                <dt>cwd</dt>
                <dd className="mono text-[11.5px]">{row.cwd ?? "—"}</dd>
              </>
            ) : null}
            <dt>Créé</dt>
            <dd>{absTime(row.createdAt)}</dd>
            {runtime ? (
              <>
                <dt>Runtime</dt>
                <dd>
                  {runtime.status} · {runtime.toolCount} outil(s) en cache · {runtime.stderr.length} ligne(s) stderr
                </dd>
              </>
            ) : null}
          </dl>
        </CardBody>
      </Card>

      <TabNav tabs={TABS} active={activeTab} basePath={"/servers/" + row.id} />

      <div className="mt-3">
        {activeTab === "tools" || activeTab === "prompts" || activeTab === "resources" ? (
          <Card>
            <CardHeader
              title={
                activeTab === "tools" ? tools.length + " outil(s)" : activeTab === "prompts" ? prompts.length + " prompt(s)" : resources.length + " ressource(s)"
              }
              subtitle="Activer/désactiver globalement, alias et description. Une désactivation globale l'emporte sur tous les droits."
            />
            <CardBody className="p-0">
              <ItemOverridesPanel
                upstreamId={row.id}
                kind={activeTab === "tools" ? "tool" : activeTab === "prompts" ? "prompt" : "resource"}
                items={(activeTab === "tools" ? tools : activeTab === "prompts" ? prompts : resources).map((i) => ({
                  name: i.name,
                  publicName: i.publicName,
                  description: i.description,
                  enabled: i.enabled,
                  alias: i.alias,
                  descriptionOverride: i.descriptionOverride,
                  truncated: i.truncated,
                }))}
              />
            </CardBody>
          </Card>
        ) : null}

        {activeTab === "access" ? (
          <div className="flex flex-col gap-3">
            <Card>
              <CardHeader
                title="Qui a accès à ce MCP"
                subtitle={row.keyAccessCount + " clé(s) et " + row.roleAccessCount + " rôle(s) avec un droit sur " + row.slug}
              />
              <CardBody className="p-0">
                {upstreamGrants.length === 0 ? (
                  <EmptyState title="Personne n'a accès à ce MCP" description="Le serveur est connecté et testable, mais aucun agent ne voit ses outils." />
                ) : (
                  <TableWrap>
                    <Table>
                      <THead>
                        <TR>
                          <TH>Sujet</TH>
                          <TH>Type</TH>
                          <TH>Mode</TH>
                          <TH className="text-right">Outils</TH>
                          <TH>Détail</TH>
                        </TR>
                      </THead>
                      <TBody>
                        {upstreamGrants.map((g) => {
                          const label =
                            g.subjectType === "key"
                              ? choices.keys.find((k) => k.id === g.subjectId)?.name ?? g.subjectId
                              : choices.roles.find((r) => r.id === g.subjectId)?.name ?? g.subjectId;
                          return (
                            <TR key={g.subjectType + g.subjectId}>
                              <TD>
                                <Link href={(g.subjectType === "key" ? "/keys/" : "/roles/") + g.subjectId} className="link">
                                  {label}
                                </Link>
                              </TD>
                              <TD>
                                <Badge tone={g.subjectType === "key" ? "accent" : "violet"}>{g.subjectType === "key" ? "clé" : "rôle"}</Badge>
                              </TD>
                              <TD>
                                {g.toolMode === "all" ? (
                                  <Badge tone="ok">tous (y compris futurs)</Badge>
                                ) : (
                                  <Badge tone="info">sélection</Badge>
                                )}
                              </TD>
                              <TD className="text-right tabular-nums">{g.toolMode === "all" ? row.toolCount : g.tools.length}</TD>
                              <TD className="max-w-[380px] truncate text-[11px] text-muted" title={g.tools.join(", ")}>
                                {g.toolMode === "all" ? "—" : g.tools.join(", ") || "aucun"}
                              </TD>
                            </TR>
                          );
                        })}
                      </TBody>
                    </Table>
                  </TableWrap>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Modifier les droits" subtitle="Sélectionnez un sujet pour éditer ses droits sur ce MCP." />
              <CardBody>
                <AccessSection
                  upstreamId={row.id}
                  upstream={{ id: row.id, slug: row.slug, name: row.name, status: row.status, enabled: row.enabled, tools: tools.map((t) => ({ name: t.name, publicName: t.publicName, description: t.description, globallyDisabled: !t.enabled })), promptCount: prompts.length, resourceCount: resources.length }}
                  keyChoices={choices.keys}
                  roleChoices={choices.roles}
                  grants={upstreamGrants}
                />
              </CardBody>
            </Card>
          </div>
        ) : null}

        {activeTab === "console" ? (
          <Card>
            <CardHeader title="Console de test" subtitle="Appelle un outil réel et affiche le résultat. Chaque essai est journalisé." />
            <CardBody>
              <TestConsole upstreamId={row.id} tools={tools.map((t) => ({ name: t.name, publicName: t.publicName }))} preselectedTool={toolParam ?? null} />
            </CardBody>
          </Card>
        ) : null}

        {activeTab === "stderr" ? (
          <Card>
            <CardHeader
              title="stderr du process stdio"
              subtitle="Anneau des 500 dernières lignes. Les secrets connus sont masqués."
              actions={row.transport === "stdio" ? undefined : <Badge tone="neutral">HTTP — pas de stderr</Badge>}
            />
            <CardBody className="p-0">
              <StderrPanel upstreamId={row.id} initialLines={stderr} disabled={row.transport !== "stdio"} />
            </CardBody>
          </Card>
        ) : null}

        {activeTab === "logs" ? (
          <div className="flex flex-col gap-3">
            <Card>
              <CardHeader title="Appels récents" subtitle={logs.total + " au total"} actions={<Link href={"/logs?upstream=" + row.id} className="btn btn-ghost btn-xs">Journal complet</Link>} />
              <CardBody className="p-0">
                <TableWrap>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Date</TH>
                        <TH>Outil</TH>
                        <TH>Clé</TH>
                        <TH>État</TH>
                        <TH className="text-right">Durée</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {logs.items.length === 0 ? (
                        <EmptyRow colSpan={5}>Aucun appel enregistré pour ce serveur.</EmptyRow>
                      ) : (
                        logs.items.map((l) => (
                          <TR key={l.id}>
                            <TD className="whitespace-nowrap text-[11.5px] text-muted" title={absTime(l.at)}>
                              {relTime(l.at)}
                            </TD>
                            <TD className="mono text-[11.5px]">{l.name}</TD>
                            <TD className="text-[11.5px]">{l.keyName ?? "—"}</TD>
                            <TD>
                              {l.denied ? <Badge tone="warn">refusé</Badge> : l.ok ? <Badge tone="ok">ok</Badge> : <Badge tone="bad">erreur</Badge>}
                            </TD>
                            <TD className="text-right tabular-nums text-muted">{duration(l.durationMs)}</TD>
                          </TR>
                        ))
                      )}
                    </TBody>
                  </Table>
                </TableWrap>
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Événements" subtitle="Cycle de vie du serveur (création, overrides, erreurs)." />
              <CardBody className="p-0">
                <TableWrap>
                  <Table>
                    <THead>
                      <TR>
                        <TH>Date</TH>
                        <TH>Type</TH>
                        <TH>Acteur</TH>
                        <TH>Message</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {events.length === 0 ? (
                        <EmptyRow colSpan={4}>Aucun événement.</EmptyRow>
                      ) : (
                        events.map((e) => (
                          <TR key={e.id}>
                            <TD className="whitespace-nowrap text-[11.5px] text-muted">{relTime(e.at)}</TD>
                            <TD className="mono text-[11px]">{e.type}</TD>
                            <TD className="text-[11.5px] text-muted">{e.actor}</TD>
                            <TD className="max-w-[520px] truncate text-[11.5px]" title={e.message}>
                              {e.message}
                            </TD>
                          </TR>
                        ))
                      )}
                    </TBody>
                  </Table>
                </TableWrap>
              </CardBody>
            </Card>
          </div>
        ) : null}

        {activeTab === "oauth" ? (
          <Card>
            <CardHeader title="OAuth 2.1" subtitle="Découverte des métadonnées, enregistrement du client, PKCE." />
            <CardBody>
              <OAuthPanel upstreamId={row.id} authType={row.authType} status={row.status} lastError={row.lastError} />
            </CardBody>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
