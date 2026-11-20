"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge, CategoryBadge, CountBadge, FeedbackStatusBadge, SeverityBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { Table, TBody, TD, TH, THead, TR, TableWrap, EmptyRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorMessage } from "@/components/client-api";
import { relTime, absTime } from "@/components/format";

export interface FeedbackRow {
  id: string;
  createdAt: number;
  lastOccurrenceAt: number;
  updatedAt: number;
  severity: string;
  category: string;
  title: string;
  status: string;
  keyId: string;
  keyName: string | null;
  upstreamSlug: string | null;
  toolName: string | null;
  occurrences: number;
  adminNote: string | null;
}

const STATUSES = [
  { value: "new", label: "Nouveaux" },
  { value: "acknowledged", label: "Acknowledgés" },
  { value: "in_progress", label: "En cours" },
  { value: "resolved", label: "Résolus" },
  { value: "wont_fix", label: "Wont fix" },
];

const CATEGORIES = [
  { value: "tool_error", label: "Outil en erreur" },
  { value: "missing_tool", label: "Outil manquant" },
  { value: "access_needed", label: "Accès nécessaire" },
  { value: "bad_description", label: "Description" },
  { value: "slow", label: "Lenteur" },
  { value: "bug", label: "Bug" },
  { value: "other", label: "Autre" },
];

const SEVERITIES = [
  { value: "blocking", label: "Bloquant" },
  { value: "high", label: "Haut" },
  { value: "medium", label: "Moyen" },
  { value: "low", label: "Bas" },
];

export function FeedbackListClient({
  items,
  keys,
  total,
  offset,
  activeFilters,
}: {
  items: FeedbackRow[];
  keys: Array<{ id: string; name: string }>;
  total: number;
  offset: number;
  activeFilters: {
    status: string[];
    category: string[];
    severity: string[];
    key: string;
    upstream: string;
    tool: string;
    search: string;
  };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const toast = useToast();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = React.useState("acknowledged");
  const [busy, setBusy] = React.useState(false);
  const [search, setSearch] = React.useState(activeFilters.search);

  function setFilter(key: string, value: string | string[]) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    const serialized = Array.isArray(value) ? value.join(",") : value;
    if (serialized) params.set(key, serialized);
    else params.delete(key);
    params.delete("offset");
    router.push("/feedback" + (params.toString() ? "?" + params.toString() : ""));
  }

  function toggleFilter(key: string, value: string) {
    const current = activeFilters[key as "status" | "category" | "severity"] ?? [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    setFilter(key, next);
  }

  async function applyBulk() {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      await apiRequest("/api/v1/feedback/bulk", { method: "POST", body: { ids: Array.from(selected), status: bulkStatus } });
      toast.push(selected.size + " retour(s) → " + bulkStatus, "ok");
      setSelected(new Set());
      router.refresh();
    } catch (err) {
      toast.push(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  }

  const pageSize = 50;
  const hasFilters =
    activeFilters.status.length > 0 ||
    activeFilters.category.length > 0 ||
    activeFilters.severity.length > 0 ||
    Boolean(activeFilters.key || activeFilters.upstream || activeFilters.tool || activeFilters.search);

  return (
    <div>
      <div className="flex flex-col gap-2 border-b border-line px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">Statut</span>
          {STATUSES.map((s) => (
            <FilterChip
              key={s.value}
              active={activeFilters.status.includes(s.value)}
              onClick={() => toggleFilter("status", s.value)}
              label={s.label}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">Gravité</span>
          {SEVERITIES.map((s) => (
            <FilterChip
              key={s.value}
              active={activeFilters.severity.includes(s.value)}
              onClick={() => toggleFilter("severity", s.value)}
              label={s.label}
            />
          ))}
          <span className="ml-3 text-[10.5px] font-semibold uppercase tracking-wider text-muted">Catégorie</span>
          {CATEGORIES.map((c) => (
            <FilterChip
              key={c.value}
              active={activeFilters.category.includes(c.value)}
              onClick={() => toggleFilter("category", c.value)}
              label={c.label}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            className="h-7 w-[180px] py-1 text-[11.5px]"
            value={activeFilters.key}
            onChange={(e) => setFilter("key", e.target.value)}
            placeholder="Toutes les clés"
            options={keys.map((k) => ({ value: k.id, label: k.name }))}
          />
          <Input
            className="h-7 w-[170px] py-1 text-[11.5px]"
            placeholder="Slug MCP…"
            defaultValue={activeFilters.upstream}
            onBlur={(e) => e.target.value !== activeFilters.upstream && setFilter("upstream", e.target.value)}
          />
          <Input
            className="h-7 w-[170px] py-1 text-[11.5px]"
            placeholder="Outil…"
            defaultValue={activeFilters.tool}
            onBlur={(e) => e.target.value !== activeFilters.tool && setFilter("tool", e.target.value)}
          />
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              setFilter("search", search);
            }}
          >
            <Input
              className="h-7 w-[220px] py-1 text-[11.5px]"
              placeholder="Rechercher dans titre / description…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Button size="xs" type="submit">
              Chercher
            </Button>
          </form>
          {hasFilters ? (
            <Button size="xs" variant="ghost" onClick={() => router.push("/feedback")}>
              Réinitialiser
            </Button>
          ) : null}
        </div>
      </div>

      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-[hsl(var(--panel-2))] px-3 py-1.5">
          <span className="text-[12px]">{selected.size} sélectionné(s)</span>
          <Select
            className="h-7 w-[170px] py-1 text-[11.5px]"
            value={bulkStatus}
            onChange={(e) => setBulkStatus(e.target.value)}
            options={STATUSES.map((s) => ({ value: s.value, label: "→ " + s.label }))}
          />
          <Button size="xs" variant="primary" onClick={applyBulk} disabled={busy}>
            {busy ? "Application…" : "Changer le statut"}
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>
            Désélectionner
          </Button>
        </div>
      ) : null}

      <TableWrap>
        <Table zebra>
          <THead>
            <TR>
              <TH className="w-[34px]">
                <Checkbox
                  checked={items.length > 0 && selected.size === items.length}
                  onChange={(next) => setSelected(next ? new Set(items.map((i) => i.id)) : new Set())}
                />
              </TH>
              <TH>Date</TH>
              <TH>Gravité</TH>
              <TH>Catégorie</TH>
              <TH>Titre</TH>
              <TH>Agent (clé)</TH>
              <TH>Outil</TH>
              <TH className="text-right">Occ.</TH>
              <TH>Statut</TH>
            </TR>
          </THead>
          <TBody>
            {items.length === 0 ? (
              <EmptyRow colSpan={9}>Aucun retour ne correspond aux filtres.</EmptyRow>
            ) : (
              items.map((f) => (
                <TR key={f.id}>
                  <TD>
                    <Checkbox
                      checked={selected.has(f.id)}
                      onChange={(next) =>
                        setSelected((prev) => {
                          const copy = new Set(prev);
                          if (next) copy.add(f.id);
                          else copy.delete(f.id);
                          return copy;
                        })
                      }
                    />
                  </TD>
                  <TD className="whitespace-nowrap text-[11.5px] text-muted" title={absTime(f.lastOccurrenceAt)}>
                    {relTime(f.lastOccurrenceAt)}
                  </TD>
                  <TD>
                    <SeverityBadge severity={f.severity} />
                  </TD>
                  <TD>
                    <CategoryBadge category={f.category} />
                  </TD>
                  <TD className="max-w-[420px]">
                    <Link href={"/feedback/" + f.id} className="block truncate text-[12.5px] font-medium text-ink hover:underline" title={f.title}>
                      {f.title}
                    </Link>
                    {f.adminNote ? <div className="truncate text-[10.5px] text-muted">note : {f.adminNote}</div> : null}
                  </TD>
                  <TD>
                    <Link href={"/keys/" + f.keyId} className="text-[11.5px] hover:underline">
                      {f.keyName ?? f.keyId.slice(0, 8)}
                    </Link>
                  </TD>
                  <TD className="mono max-w-[200px] truncate text-[11px]" title={f.toolName ?? ""}>
                    {f.toolName ?? "—"}
                  </TD>
                  <TD className="text-right">
                    {f.occurrences > 1 ? <CountBadge count={f.occurrences} tone="bad" /> : <span className="text-[11px] text-muted">1</span>}
                  </TD>
                  <TD>
                    <FeedbackStatusBadge status={f.status} />
                  </TD>
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
            <Button size="xs" variant="ghost" disabled={offset === 0} onClick={() => {
              const params = new URLSearchParams(searchParams?.toString() ?? "");
              params.set("offset", String(Math.max(0, offset - pageSize)));
              router.push("/feedback?" + params.toString());
            }}>
              Précédent
            </Button>
            <Button size="xs" variant="ghost" disabled={offset + pageSize >= total} onClick={() => {
              const params = new URLSearchParams(searchParams?.toString() ?? "");
              params.set("offset", String(offset + pageSize));
              router.push("/feedback?" + params.toString());
            }}>
              Suivant
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "rounded-full border px-2 py-0.5 text-[11px] transition-colors " +
        (active ? "border-accent bg-[hsl(var(--panel-3))] text-ink" : "border-line text-muted hover:text-ink")
      }
    >
      {label}
    </button>
  );
}
