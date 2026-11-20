import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUiAuth } from "@/components/server/auth";
import { getFeedback } from "@/lib/feedback";
import { getDb } from "@/lib/db";
import { upstreams } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { Badge, CategoryBadge, FeedbackStatusBadge, SeverityBadge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR, TableWrap, EmptyRow } from "@/components/ui/table";
import { Callout, Code, Mono } from "@/components/ui/misc";
import { absTime, duration, relTime } from "@/components/format";
import { FeedbackDetailActions, QuickActions } from "./feedback-detail-actions";

export const metadata: Metadata = { title: "Fiche retour — Switchboard" };
export const dynamic = "force-dynamic";

export default async function FeedbackDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUiAuth();
  const { id } = await params;

  let detail: ReturnType<typeof getFeedback> = null;
  try {
    detail = getFeedback(id);
  } catch {
    detail = null;
  }
  if (!detail) notFound();

  // Resolve the related tool to its upstream for the "ouvrir la fiche du serveur" quick action.
  let upstreamId: string | null = null;
  let serverName: string | null = null;
  try {
    const db = getDb();
    if (detail.upstreamSlug) {
      const row = db.select().from(upstreams).where(eq(upstreams.slug, detail.upstreamSlug)).get();
      if (row) {
        upstreamId = row.id;
        serverName = row.name;
      }
    }
  } catch {
    /* ignore */
  }

  const clientInfo = detail.clientInfo as { name?: string; version?: string } | null;

  return (
    <div>
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {detail.title}
          </span>
        }
        breadcrumb={
          <span>
            <Link href="/feedback" className="link">
              Retours
            </Link>{" "}
            / <span className="mono">#{detail.id.replace(/-/g, "").slice(0, 6)}</span>
          </span>
        }
        actions={
          <FeedbackDetailActions
            id={detail.id}
            status={detail.status}
            adminNote={detail.adminNote}
            category={detail.category}
            keyId={detail.keyId}
            toolName={detail.toolName}
            upstreamSlug={detail.upstreamSlug}
            upstreamId={upstreamId}
          />
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SeverityBadge severity={detail.severity} />
        <CategoryBadge category={detail.category} />
        <FeedbackStatusBadge status={detail.status} />
        {detail.occurrences > 1 ? <Badge tone="bad">{detail.occurrences} occurrences</Badge> : null}
        <span className="text-[11.5px] text-muted">
          créé {relTime(detail.createdAt)} · dernière occurrence {relTime(detail.lastOccurrenceAt)}
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.5fr_1fr]">
        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader title="Description" subtitle="Texte fourni par l'agent (secrets masqués)." />
            <CardBody>
              <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{detail.description}</p>
            </CardBody>
          </Card>

          {detail.attemptedAction || detail.errorMessage ? (
            <Card>
              <CardHeader title="Contexte de l'appel" />
              <CardBody className="flex flex-col gap-3">
                {detail.attemptedAction ? (
                  <div>
                    <span className="label">Action tentée</span>
                    <p className="whitespace-pre-wrap text-[12px]">{detail.attemptedAction}</p>
                  </div>
                ) : null}
                {detail.errorMessage ? (
                  <div>
                    <span className="label">Message d&apos;erreur reçu</span>
                    <Code>{detail.errorMessage}</Code>
                  </div>
                ) : null}
              </CardBody>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="Appel lié"
              subtitle={
                detail.relatedCall
                  ? "Dernier appel en erreur de cette session sur cet outil."
                  : "Aucun appel en erreur lié automatiquement."
              }
            />
            <CardBody className="p-0">
              {detail.relatedCall ? (
                <div className="flex flex-col gap-2 p-3">
                  <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                    <Mono className="text-[12px]">{detail.relatedCall.name}</Mono>
                    {detail.relatedCall.ok ? <Badge tone="ok">ok</Badge> : <Badge tone="bad">erreur</Badge>}
                    {detail.relatedCall.denied ? <Badge tone="warn">refusé</Badge> : null}
                    {detail.relatedCall.errorCode ? <Badge tone="warn">{detail.relatedCall.errorCode}</Badge> : null}
                    <span className="text-muted">{absTime(detail.relatedCall.at)}</span>
                    <span className="text-muted">{duration(detail.relatedCall.durationMs)}</span>
                  </div>
                  <div>
                    <span className="label">Arguments (aperçu tronqué à 2 Ko, secrets masqués)</span>
                    <Code>{detail.relatedCall.argsPreview ?? "(aucun)"}</Code>
                  </div>
                  <div>
                    <span className="label">Résultat / erreur</span>
                    <Code>{detail.relatedCall.resultPreview ?? "(aucun)"}</Code>
                  </div>
                </div>
              ) : (
                <p className="px-3 py-5 text-center text-[12px] text-muted">
                  Aucun appel lié. L&apos;agent n&apos;a pas fourni d&apos;outil, ou aucun appel en erreur de cette session ne correspond.
                </p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title={"Autres appels de la session"} subtitle={detail.sessionId ? "10 plus récents" : "session inconnue"} />
            <CardBody className="p-0">
              <TableWrap>
                <Table>
                  <THead>
                    <TR>
                      <TH>Date</TH>
                      <TH>Outil</TH>
                      <TH>État</TH>
                      <TH className="text-right">Durée</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {detail.recentCalls.length === 0 ? (
                      <EmptyRow colSpan={4}>Aucun appel enregistré pour cette session.</EmptyRow>
                    ) : (
                      detail.recentCalls.map((c) => (
                        <TR key={c.id}>
                          <TD className="whitespace-nowrap text-[11.5px] text-muted">{relTime(c.at)}</TD>
                          <TD className="mono text-[11.5px]">{c.name}</TD>
                          <TD>
                            {c.denied ? <Badge tone="warn">refusé</Badge> : c.ok ? <Badge tone="ok">ok</Badge> : <Badge tone="bad">erreur</Badge>}
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
        </div>

        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader title="Actions rapides" subtitle="Selon la catégorie du retour." />
            <CardBody>
              <QuickActions
                category={detail.category}
                keyId={detail.keyId}
                toolName={detail.toolName}
                upstreamId={upstreamId}
                upstreamSlug={detail.upstreamSlug}
                serverName={serverName}
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Contexte" />
            <CardBody>
              <dl className="kv">
                <dt>ID</dt>
                <dd className="mono text-[11px] select-all">{detail.id}</dd>
                <dt>Agent (clé)</dt>
                <dd>
                  <Link href={"/keys/" + detail.keyId} className="link">
                    {detail.keyName ?? detail.keyId}
                  </Link>
                </dd>
                <dt>Session</dt>
                <dd className="mono text-[11px]">{detail.sessionId ?? "—"}</dd>
                <dt>Client MCP</dt>
                <dd>
                  {clientInfo?.name ?? "—"}
                  {clientInfo?.version ? " v" + clientInfo.version : ""}
                </dd>
                <dt>Serveur</dt>
                <dd className="mono text-[11.5px]">
                  {detail.upstreamSlug ? (
                    upstreamId ? (
                      <Link href={"/servers/" + upstreamId} className="link">
                        {detail.upstreamSlug}
                      </Link>
                    ) : (
                      detail.upstreamSlug
                    )
                  ) : (
                    "—"
                  )}
                </dd>
                <dt>Outil</dt>
                <dd className="mono text-[11.5px]">{detail.toolName ?? "—"}</dd>
                <dt>Occurrences</dt>
                <dd>{detail.occurrences}</dd>
                <dt>Créé</dt>
                <dd>{absTime(detail.createdAt)}</dd>
                <dt>Dernière</dt>
                <dd>{absTime(detail.lastOccurrenceAt)}</dd>
                {detail.resolvedAt ? (
                  <>
                    <dt>Résolu</dt>
                    <dd>{absTime(detail.resolvedAt)}</dd>
                  </>
                ) : null}
              </dl>
            </CardBody>
          </Card>

          {detail.adminNote ? (
            <Card>
              <CardHeader title="Note d'admin" />
              <CardBody>
                <p className="whitespace-pre-wrap text-[12px]">{detail.adminNote}</p>
              </CardBody>
            </Card>
          ) : null}

          {detail.category === "access_needed" ? (
            <Callout tone="info" title="Accès demandé">
              Utilisez « Accorder cet outil » : l&apos;éditeur de droits s&apos;ouvre pré-rempli sur la clé et l&apos;outil concernés. L&apos;agent
              verra le changement en moins de 5 s s&apos;il gère list_changed.
            </Callout>
          ) : null}
        </div>
      </div>
    </div>
  );
}