import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUiAuth } from "@/components/server/auth";
import { callsForKey, deniesForKey, listEvents } from "@/components/server/data";
import { editorData, grantsForSubject, keyOrigins } from "@/components/server/access-data";
import { effectiveAccessDb } from "@/components/server/access-db";
import { catalogFromDb } from "@/components/server/catalog-db";
import { getKey } from "@/lib/auth/keys";
import { listRoles } from "@/lib/auth/grants";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR, TableWrap, EmptyRow } from "@/components/ui/table";
import { TabNav } from "@/components/ui/tabs";
import { Callout, Mono } from "@/components/ui/misc";
import { absTime, duration, estimateTokens, keyStatus, num, relTime } from "@/components/format";
import { InstallPanel, KeyActions, RightsTab, SessionsPanel } from "./key-tabs";

export const metadata: Metadata = { title: "Fiche clé — Switchboard" };
export const dynamic = "force-dynamic";

const TABS = [
  { id: "rights", label: "Droits" },
  { id: "effective", label: "Aperçu effectif" },
  { id: "sessions", label: "Sessions" },
  { id: "logs", label: "Journal" },
  { id: "history", label: "Historique" },
  { id: "install", label: "Installation" },
];

export default async function KeyDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireUiAuth();
  const { id } = await params;
  const { tab } = await searchParams;
  const activeTab = TABS.some((t) => t.id === tab) ? (tab as string) : "rights";

  const key = getKey(id);
  if (!key) notFound();

  // Each read is independent: one failing query must not blank the whole page.
  let upstreams: ReturnType<typeof editorData>["upstreams"] = [];
  let grants: ReturnType<typeof grantsForSubject> = [];
  let origins: ReturnType<typeof keyOrigins> = { origins: {}, denies: [], roleIds: [], roleNames: [] };
  let roles: ReturnType<typeof listRoles> = [];
  let calls: ReturnType<typeof callsForKey> = [];
  let events: ReturnType<typeof listEvents> = [];
  let denies: ReturnType<typeof deniesForKey> = [];
  try {
    upstreams = editorData().upstreams;
  } catch {
    upstreams = [];
  }
  try {
    grants = grantsForSubject("key", id);
  } catch {
    grants = [];
  }
  try {
    origins = keyOrigins(id);
  } catch {
    origins = { origins: {}, denies: [], roleIds: key.roleIds, roleNames: [] };
  }
  try {
    roles = listRoles();
  } catch {
    roles = [];
  }
  try {
    calls = callsForKey(id, 50);
  } catch {
    calls = [];
  }
  try {
    events = listEvents({ keyId: id, limit: 80 });
  } catch {
    events = [];
  }
  try {
    denies = deniesForKey(id);
  } catch {
    denies = [];
  }

  const status = keyStatus(key);
  const roleNames = key.roleIds.map((rid) => roles.find((r) => r.id === rid)?.name ?? rid);

  // Effective view from the DB (never the process-local snapshot) + ~chars/4 token estimate.
  let toolCount = 0;
  let upstreamCount = 0;
  let promptCount = 0;
  let resourceCount = 0;
  let tokenEstimate = 0;
  const effectiveUpstreams: Array<{
    slug: string;
    name: string;
    tools: Array<{ publicName: string; description: string | null }>;
    removed: number;
    disabled: number;
    sources: string[];
  }> = [];

  try {
    const access = effectiveAccessDb(id);
    const catalog = new Map(catalogFromDb().map((u) => [u.id, u] as const));
    let chars = 400; // report_feedback tool definition is always visible

    for (const [upstreamId, entry] of Object.entries(access?.upstreams ?? {})) {
      if (!entry.hasAccess && entry.tools.length === 0) continue;
      upstreamCount += 1;
      toolCount += entry.tools.length;
      promptCount += entry.prompts?.length ?? 0;
      resourceCount += entry.resources?.length ?? 0;

      const view = catalog.get(upstreamId);
      const tools = entry.tools
        .map((name) => {
          const found = view?.tools.find((t) => t.name === name);
          return { publicName: found?.publicName ?? entry.upstreamSlug + "__" + name, description: found?.description ?? null };
        })
        .sort((a, b) => a.publicName.localeCompare(b.publicName));

      for (const tool of tools) chars += JSON.stringify(tool).length + 40;
      effectiveUpstreams.push({
        slug: entry.upstreamSlug,
        name: view?.name ?? entry.upstreamSlug,
        tools,
        removed: entry.removedByDeny.length,
        disabled: entry.disabledGlobally.length,
        sources: entry.sources.map((s) => s.label),
      });
    }
    effectiveUpstreams.sort((a, b) => a.slug.localeCompare(b.slug));
    tokenEstimate = estimateTokens(chars);
  } catch {
    /* keep the zeroed view */
  }

  const calls24h = calls.filter((c) => c.at > Date.now() - 86_400_000);
  const deniedRecent = calls.filter((c) => c.denied).length;

  return (
    <div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {key.name}
            <Badge tone={status === "active" ? "ok" : status === "revoked" ? "bad" : "warn"}>
              {status === "active" ? "active" : status === "revoked" ? "révoquée" : "expirée"}
            </Badge>
            {key.scope === "admin" ? <Badge tone="warn">scope admin</Badge> : null}
            <Badge tone={key.exposureMode === "discovery" ? "info" : "neutral"}>{key.exposureMode}</Badge>
          </span>
        }
        description={key.description ?? undefined}
        breadcrumb={
          <span>
            <Link href="/keys" className="link">
              Clés API
            </Link>{" "}
            / <span className="mono">{key.name}</span>
          </span>
        }
        actions={
          <KeyActions
            keyId={key.id}
            name={key.name}
            revoked={key.revokedAt !== null}
            roleIds={key.roleIds}
            roles={roles.map((r) => ({ id: r.id, name: r.name }))}
            exposureMode={key.exposureMode}
          />
        }
      />

      {status === "revoked" ? (
        <div className="mb-3">
          <Callout tone="bad" title="Clé révoquée">
            Révoquée {relTime(key.revokedAt)}. Toutes ses sessions MCP ont été fermées ; les appels renvoient 401. Une clé révoquée ne peut pas
            être réactivée — créez-en une nouvelle ou dupliquez-la.
          </Callout>
        </div>
      ) : null}
      {status === "expired" ? (
        <div className="mb-3">
          <Callout tone="warn" title="Clé expirée">
            Expirée {relTime(key.expiresAt)}. Les agents sont refusés au prochain appel. Modifiez la date d&apos;expiration pour la prolonger.
          </Callout>
        </div>
      ) : null}
      {status === "active" && toolCount === 0 ? (
        <div className="mb-3">
          <Callout tone="info" title="Cette clé ne voit aucun outil">
            Aucun droit accordé. Tant que rien n&apos;est coché dans l&apos;onglet Droits, l&apos;agent obtient une liste vide (à l&apos;exception de
            <span className="mono"> report_feedback</span>). Vérifiez aussi que ses serveurs sont connectés : un MCP non prêt ne publie rien.
          </Callout>
        </div>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Préfixe" value={<span className="mono text-[15px]">{key.prefix}…</span>} hint="secret non récupérable" />
        <Stat label="MCP accessibles" value={num(upstreamCount)} hint={upstreams.length + " au catalogue"} />
        <Stat label="Outils" value={num(toolCount)} hint={promptCount + " prompts · " + resourceCount + " ress."} />
        <Stat label="Tokens estimés" value={"~" + num(tokenEstimate)} hint="chars/4, liste des outils" />
        <Stat label="Dernière utilisation" value={relTime(key.lastUsedAt)} hint={key.lastUsedAt ? absTime(key.lastUsedAt) : "jamais"} />
        <Stat label="Appels 24 h" value={num(calls24h.length)} hint={deniedRecent + " refus (50 derniers)"} />
      </div>

      <Card className="mb-3">
        <CardBody className="py-2.5">
          <dl className="kv">
            <dt>ID</dt>
            <dd className="mono select-all text-[11.5px]">{key.id}</dd>
            <dt>Rôles</dt>
            <dd className="flex flex-wrap gap-1">
              {roleNames.length === 0 ? (
                <span className="text-muted">aucun</span>
              ) : (
                roleNames.map((n) => (
                  <Badge key={n} tone="violet">
                    {n}
                  </Badge>
                ))
              )}
            </dd>
            <dt>Créée</dt>
            <dd>
              {absTime(key.createdAt)}
              {key.rotatedAt ? <span className="ml-2 text-muted">· dernier secret régénéré {relTime(key.rotatedAt)}</span> : null}
            </dd>
            <dt>Expiration</dt>
            <dd>{key.expiresAt ? absTime(key.expiresAt) + " (" + relTime(key.expiresAt) + ")" : "jamais"}</dd>
            <dt>Retraits</dt>
            <dd>
              {denies.length === 0
                ? "aucun"
                : denies.map((d) => (d.toolName === null ? "⊘ MCP entier" : "⊘ " + d.toolName)).join(" · ")}
            </dd>
          </dl>
        </CardBody>
      </Card>

      <TabNav tabs={TABS} active={activeTab} basePath={"/keys/" + key.id} />

      <div className="mt-3">
        {activeTab === "rights" ? (
          <Card>
            <CardHeader
              title="Droits de cette clé"
              subtitle="Un accordéon par MCP : Aucun / Tous les outils (y compris futurs) / Sélection. Le retrait l'emporte sur un ajout."
            />
            <CardBody>
              <RightsTab keyId={key.id} upstreams={upstreams} grants={grants} origins={origins} />
            </CardBody>
          </Card>
        ) : null}

        {activeTab === "effective" ? (
          <Card>
            <CardHeader
              title="Aperçu effectif"
              subtitle={
                toolCount + " outil(s) · ~" + num(tokenEstimate) + " tokens estimés — ce que l'agent voit après filtrage."
              }
            />
            <CardBody className="p-0">
              {effectiveUpstreams.length === 0 ? (
                <EmptyState
                  title="Aucun outil visible"
                  description="Cette clé n'a aucun droit, ou tous ses serveurs sont hors ligne. En mode découverte l'agent voit tout de même search_tools / describe_tool / call_tool / report_feedback."
                />
              ) : (
                <div className="divide-line">
                  {effectiveUpstreams.map((u) => (
                    <div key={u.slug} className="px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Mono className="text-[12px] font-semibold text-ink">{u.slug}</Mono>
                        <span className="text-[11.5px] text-muted">{u.name}</span>
                        <Badge tone="neutral">{u.tools.length} outil(s)</Badge>
                        {u.removed > 0 ? <Badge tone="warn">{u.removed} retiré(s)</Badge> : null}
                        {u.disabled > 0 ? <Badge tone="warn">{u.disabled} désactivé(s) globalement</Badge> : null}
                        {u.sources.length > 0 ? <span className="text-[11px] text-muted">via {u.sources.join(", ")}</span> : null}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {u.tools.length === 0 ? (
                          <span className="text-[11.5px] text-muted">
                            Aucun outil visible — le serveur est peut-être hors ligne (statut différent de « prêt »).
                          </span>
                        ) : (
                          u.tools.map((t) => (
                            <span key={t.publicName} className="pill mono" title={t.description ?? undefined}>
                              {t.publicName}
                            </span>
                          ))
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>
        ) : null}

        {activeTab === "sessions" ? (
          <Card>
            <CardHeader title="Sessions MCP" subtitle="Sessions ouvertes pour cette clé (client, version, IP, depuis)." />
            <CardBody>
              <SessionsPanel keyId={key.id} />
            </CardBody>
          </Card>
        ) : null}

        {activeTab === "logs" ? (
          <Card>
            <CardHeader
              title="Journal de la clé"
              subtitle="50 derniers appels"
              actions={
                <Link href={"/logs?key=" + key.id} className="btn btn-ghost btn-xs">
                  Journal complet
                </Link>
              }
            />
            <CardBody className="p-0">
              <TableWrap>
                <Table>
                  <THead>
                    <TR>
                      <TH>Date</TH>
                      <TH>Serveur</TH>
                      <TH>Nom</TH>
                      <TH>Type</TH>
                      <TH>État</TH>
                      <TH className="text-right">Durée</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {calls.length === 0 ? (
                      <EmptyRow colSpan={6}>Aucun appel enregistré pour cette clé.</EmptyRow>
                    ) : (
                      calls.map((c) => (
                        <TR key={c.id}>
                          <TD className="whitespace-nowrap text-[11.5px] text-muted" title={absTime(c.at)}>
                            {relTime(c.at)}
                          </TD>
                          <TD className="mono text-[11.5px]">{c.upstreamSlug ?? "—"}</TD>
                          <TD className="mono max-w-[260px] truncate text-[11.5px]" title={c.name}>
                            {c.name}
                          </TD>
                          <TD className="text-[11px] text-muted">{c.kind}</TD>
                          <TD>
                            {c.denied ? (
                              <Badge tone="warn">refusé</Badge>
                            ) : c.ok ? (
                              <Badge tone="ok">ok</Badge>
                            ) : (
                              <Badge tone="bad">erreur</Badge>
                            )}
                          </TD>
                          <TD className="text-right tabular-nums text-muted">{duration(c.durationMs)}</TD>
                        </TR>
                      ))
                    )}
                  </TBody>
                </Table>
              </TableWrap>
            </CardBody>
          </Card>
        ) : null}

        {activeTab === "history" ? (
          <Card>
            <CardHeader title="Historique des droits" subtitle="Événements de création, mise à jour, rôles et retraits touchant cette clé." />
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
                      <EmptyRow colSpan={4}>Aucun événement enregistré pour cette clé.</EmptyRow>
                    ) : (
                      events.map((e) => (
                        <TR key={e.id}>
                          <TD className="whitespace-nowrap text-[11.5px] text-muted" title={absTime(e.at)}>
                            {relTime(e.at)}
                          </TD>
                          <TD className="mono text-[11px]">{e.type}</TD>
                          <TD className="text-[11.5px] text-muted">{e.actor}</TD>
                          <TD className="max-w-[620px] text-[11.5px]">{e.message}</TD>
                        </TR>
                      ))
                    )}
                  </TBody>
                </Table>
              </TableWrap>
            </CardBody>
          </Card>
        ) : null}

        {activeTab === "install" ? <InstallPanel keyId={key.id} keyName={key.name} /> : null}
      </div>
    </div>
  );
}
