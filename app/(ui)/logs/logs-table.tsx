"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR, TableWrap, EmptyRow } from "@/components/ui/table";
import { Code, Mono } from "@/components/ui/misc";
import { Modal } from "@/components/ui/dialog";
import { absTime, duration, relTime } from "@/components/format";

export interface LogItem {
  id: string;
  at: number;
  keyId: string | null;
  keyName: string | null;
  upstreamId: string | null;
  upstreamSlug: string | null;
  sessionId: string | null;
  kind: string;
  name: string;
  argsPreview: string | null;
  resultPreview: string | null;
  ok: boolean;
  denied: boolean;
  errorCode: string | null;
  durationMs: number | null;
}

export function LogsTable({
  items,
  total,
  offset,
  keys,
  upstreams,
  filters,
}: {
  items: LogItem[];
  total: number;
  offset: number;
  keys: Array<{ id: string; name: string }>;
  upstreams: Array<{ id: string; slug: string; name: string }>;
  filters: { outcome: string; key: string; upstream: string; name: string; kind: string; since: string };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [name, setName] = React.useState(filters.name);
  const [detail, setDetail] = React.useState<LogItem | null>(null);

  function setFilter(key: string, value: string) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (value && value !== "all") params.set(key, value);
    else params.delete(key);
    params.delete("offset");
    router.push("/logs" + (params.toString() ? "?" + params.toString() : ""));
  }

  const pageSize = 100;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Select
          className="h-7 w-[140px] py-1 text-[11.5px]"
          value={filters.outcome}
          onChange={(e) => setFilter("outcome", e.target.value)}
          options={[
            { value: "all", label: "Tous les états" },
            { value: "ok", label: "Réussis" },
            { value: "error", label: "Erreurs" },
            { value: "denied", label: "Refusés" },
          ]}
        />
        <Select
          className="h-7 w-[160px] py-1 text-[11.5px]"
          value={filters.key}
          onChange={(e) => setFilter("key", e.target.value)}
          placeholder="Toutes les clés"
          options={keys.map((k) => ({ value: k.id, label: k.name }))}
        />
        <Select
          className="h-7 w-[160px] py-1 text-[11.5px]"
          value={filters.upstream}
          onChange={(e) => setFilter("upstream", e.target.value)}
          placeholder="Tous les serveurs"
          options={upstreams.map((u) => ({ value: u.id, label: u.slug + " — " + u.name }))}
        />
        <Select
          className="h-7 w-[130px] py-1 text-[11.5px]"
          value={filters.kind}
          onChange={(e) => setFilter("kind", e.target.value)}
          options={[
            { value: "all", label: "Tous types" },
            { value: "tool", label: "tool" },
            { value: "prompt", label: "prompt" },
            { value: "resource", label: "resource" },
          ]}
        />
        <Select
          className="h-7 w-[150px] py-1 text-[11.5px]"
          value={filters.since}
          onChange={(e) => setFilter("since", e.target.value)}
          options={[
            { value: "0", label: "Tout l'historique" },
            { value: "1", label: "Dernière heure" },
            { value: "24", label: "24 heures" },
            { value: "168", label: "7 jours" },
          ]}
        />
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter("name", name);
          }}
        >
          <Input className="h-7 w-[200px] py-1 text-[11.5px]" placeholder="Nom d'outil…" value={name} onChange={(e) => setName(e.target.value)} />
          <Button size="xs" type="submit">
            Filtrer
          </Button>
        </form>
      </div>

      <TableWrap>
        <Table>
          <THead>
            <TR>
              <TH>Date</TH>
              <TH>Clé</TH>
              <TH>Serveur</TH>
              <TH>Outil / élément</TH>
              <TH>Type</TH>
              <TH>État</TH>
              <TH className="text-right">Durée</TH>
            </TR>
          </THead>
          <TBody>
            {items.length === 0 ? (
              <EmptyRow colSpan={7}>Aucun appel ne correspond aux filtres.</EmptyRow>
            ) : (
              items.map((l) => (
                <TR key={l.id} onClick={() => setDetail(l)}>
                  <TD className="whitespace-nowrap text-[11.5px] text-muted" title={absTime(l.at)}>
                    {relTime(l.at)}
                  </TD>
                  <TD className="max-w-[140px] truncate text-[11.5px]">{l.keyName ?? "—"}</TD>
                  <TD className="mono text-[11.5px]">{l.upstreamSlug ?? "—"}</TD>
                  <TD className="mono max-w-[320px] truncate text-[11.5px]" title={l.name}>
                    {l.name}
                  </TD>
                  <TD className="text-[11px] text-muted">{l.kind}</TD>
                  <TD>
                    {l.denied ? <Badge tone="warn">refusé</Badge> : l.ok ? <Badge tone="ok">ok</Badge> : <Badge tone="bad">erreur</Badge>}
                    {l.errorCode ? <Badge tone="neutral" className="ml-1">{l.errorCode}</Badge> : null}
                  </TD>
                  <TD className="text-right tabular-nums text-muted">{duration(l.durationMs)}</TD>
                </TR>
              ))
            )}
          </TBody>
        </Table>
      </TableWrap>

      {total > pageSize ? (
        <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[11.5px] text-muted">
          <span>
            {offset + 1}–{Math.min(offset + pageSize, total)} sur {total}
          </span>
          <div className="flex gap-1">
            <Button
              size="xs"
              variant="ghost"
              disabled={offset === 0}
              onClick={() => {
                const params = new URLSearchParams(searchParams?.toString() ?? "");
                params.set("offset", String(Math.max(0, offset - pageSize)));
                router.push("/logs?" + params.toString());
              }}
            >
              Précédent
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={offset + pageSize >= total}
              onClick={() => {
                const params = new URLSearchParams(searchParams?.toString() ?? "");
                params.set("offset", String(offset + pageSize));
                router.push("/logs?" + params.toString());
              }}
            >
              Suivant
            </Button>
          </div>
        </div>
      ) : null}

      <Modal open={detail !== null} onClose={() => setDetail(null)} title="Détail de l'appel" width="max-w-[720px]">
        {detail ? (
          <div className="flex flex-col gap-3">
            <dl className="kv">
              <dt>ID</dt>
              <dd className="mono text-[11px] select-all">{detail.id}</dd>
              <dt>Date</dt>
              <dd>{absTime(detail.at)}</dd>
              <dt>Clé</dt>
              <dd>
                {detail.keyName ?? "—"}
                {detail.keyId ? <span className="ml-1 mono text-[10.5px] text-muted">{detail.keyId.slice(0, 8)}</span> : null}
              </dd>
              <dt>Serveur</dt>
              <dd className="mono">{detail.upstreamSlug ?? "—"}</dd>
              <dt>Élément</dt>
              <dd className="mono">
                {detail.name} <span className="text-muted">({detail.kind})</span>
              </dd>
              <dt>Session</dt>
              <dd className="mono text-[11px]">{detail.sessionId ?? "—"}</dd>
              <dt>État</dt>
              <dd>
                {detail.denied ? <Badge tone="warn">refusé</Badge> : detail.ok ? <Badge tone="ok">ok</Badge> : <Badge tone="bad">erreur</Badge>}
                {detail.errorCode ? <span className="ml-2 mono text-[11px] text-muted">{detail.errorCode}</span> : null}
              </dd>
              <dt>Durée</dt>
              <dd>{duration(detail.durationMs)}</dd>
            </dl>
            <div>
              <span className="label">Arguments</span>
              <Code>{detail.argsPreview ?? "(aucun)"}</Code>
            </div>
            <div>
              <span className="label">Résultat</span>
              <Code>{detail.resultPreview ?? "(aucun)"}</Code>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
