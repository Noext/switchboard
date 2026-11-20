"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Input, Select } from "@/components/ui/input";
import { SlideOver } from "@/components/ui/dialog";
import { Callout } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorMessage } from "@/components/client-api";
import { cn } from "@/components/ui/cn";
import type { EditorUpstream } from "@/components/access/access-editor";

export interface MatrixUpstream {
  id: string;
  slug: string;
  name: string;
  toolCount: number;
}

export type CellKind = "all" | "selected" | "none" | "denied";

export interface MatrixRowData {
  subjectType: "key" | "role";
  subjectId: string;
  label: string;
  cells: Record<string, { kind: CellKind; selected: number; total: number; toolNames: string[] }>;
  grants?: Array<{ upstreamId: string; mode: "all" | "selected"; tools: string[]; prompts: boolean; resources: boolean }>;
  denies?: Array<{ upstreamId: string; toolName: string | null }>;
}

const LEGEND: Array<{ symbol: string; label: string }> = [
  { symbol: "●", label: "tous les outils" },
  { symbol: "◐", label: "sélection" },
  { symbol: "○", label: "aucun" },
  { symbol: "⊘", label: "retiré" },
];

function cellSymbol(cell: { kind: CellKind; selected: number; total: number } | undefined): string {
  if (!cell || cell.kind === "none") return "○";
  if (cell.kind === "all") return "●";
  if (cell.kind === "denied") return "⊘";
  return "◐ " + cell.selected + "/" + cell.total;
}

function cellClass(cell: { kind: CellKind } | undefined): string {
  if (!cell || cell.kind === "none") return "text-[hsl(var(--line-strong))]";
  if (cell.kind === "all") return "text-accent";
  if (cell.kind === "denied") return "text-bad";
  return "text-warn";
}

export function MatrixGrid({
  upstreams,
  rows,
  editorUpstreams,
}: {
  upstreams: MatrixUpstream[];
  rows: MatrixRowData[];
  editorUpstreams: EditorUpstream[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [subjectType, setSubjectType] = React.useState<"all" | "key" | "role">("all");
  const [query, setQuery] = React.useState("");
  const [upstreamFilter, setUpstreamFilter] = React.useState("");
  const [onlyWithAccess, setOnlyWithAccess] = React.useState(false);
  const [cellFilter, setCellFilter] = React.useState<"all" | CellKind>("all");

  const [panel, setPanel] = React.useState<{ row: MatrixRowData; upstream: MatrixUpstream } | null>(null);
  const [mode, setMode] = React.useState<"none" | "all" | "selected">("none");
  const [tools, setTools] = React.useState<Set<string>>(new Set());
  const [prompts, setPrompts] = React.useState(false);
  const [resources, setResources] = React.useState(false);
  const [toolSearch, setToolSearch] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const visibleUpstreams = upstreamFilter ? upstreams.filter((u) => u.id === upstreamFilter) : upstreams;

  const filteredRows = rows.filter((row) => {
    if (subjectType !== "all" && row.subjectType !== subjectType) return false;
    if (query && !row.label.toLowerCase().includes(query.toLowerCase())) return false;
    if (onlyWithAccess) {
      const has = Object.entries(row.cells).some(([uid, c]) => (!upstreamFilter || uid === upstreamFilter) && c.kind !== "none");
      if (!has) return false;
    }
    if (cellFilter !== "all") {
      const has = Object.entries(row.cells).some(
        ([uid, c]) => (!upstreamFilter || uid === upstreamFilter) && c.kind === cellFilter,
      );
      if (!has) return false;
    }
    return true;
  });

  const keyRows = filteredRows.filter((r) => r.subjectType === "key");
  const roleRows = filteredRows.filter((r) => r.subjectType === "role");

  function openCell(row: MatrixRowData, upstream: MatrixUpstream) {
    const grant = row.grants?.find((g) => g.upstreamId === upstream.id);
    const cell = row.cells[upstream.id];
    const deniedAll = row.denies?.some((d) => d.upstreamId === upstream.id && d.toolName === null) ?? false;
    setPanel({ row, upstream });
    setMode(deniedAll ? "none" : !grant ? "none" : grant.mode);
    setTools(new Set(grant?.tools ?? cell?.toolNames ?? []));
    setPrompts(grant?.prompts ?? false);
    setResources(grant?.resources ?? false);
    setToolSearch("");
  }

  async function apply() {
    if (!panel) return;
    setBusy(true);
    const { row, upstream } = panel;
    try {
      if (mode === "none") {
        await apiRequest("/api/v1/grants", {
          method: "PUT",
          body: {
            subjectType: row.subjectType,
            subjectId: row.subjectId,
            upstreamId: upstream.id,
            toolMode: "selected",
            tools: [],
            prompts: false,
            resources: false,
          },
        });
        // An empty "selected" grant is how the UI expresses "no access" (the API upserts on the triple).
      } else {
        await apiRequest("/api/v1/grants", {
          method: "PUT",
          body: {
            subjectType: row.subjectType,
            subjectId: row.subjectId,
            upstreamId: upstream.id,
            toolMode: mode,
            tools: mode === "selected" ? Array.from(tools) : [],
            prompts,
            resources,
          },
        });
      }
      toast.push("Droits de " + row.label + " sur " + upstream.slug + " enregistrés.", "ok");
      setPanel(null);
      router.refresh();
    } catch (err) {
      toast.push(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  }

  const editorFor = panel ? editorUpstreams.find((u) => u.id === panel.upstream.id) : undefined;
  const panelTools = editorFor?.tools ?? [];
  const filteredTools = toolSearch
    ? panelTools.filter((t) => t.name.toLowerCase().includes(toolSearch.toLowerCase()))
    : panelTools;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Input
          className="h-7 w-[180px] py-1 text-[11.5px]"
          placeholder="Filtrer par nom…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select
          className="h-7 w-[150px] py-1 text-[11.5px]"
          value={subjectType}
          onChange={(e) => setSubjectType(e.target.value as "all" | "key" | "role")}
          options={[
            { value: "all", label: "Clés + rôles" },
            { value: "key", label: "Clés seulement" },
            { value: "role", label: "Rôles seulement" },
          ]}
        />
        <Select
          className="h-7 w-[170px] py-1 text-[11.5px]"
          value={upstreamFilter}
          onChange={(e) => setUpstreamFilter(e.target.value)}
          placeholder="Tous les MCP"
          options={upstreams.map((u) => ({ value: u.id, label: u.slug }))}
        />
        <Select
          className="h-7 w-[160px] py-1 text-[11.5px]"
          value={cellFilter}
          onChange={(e) => setCellFilter(e.target.value as "all" | CellKind)}
          options={[
            { value: "all", label: "Toutes les cellules" },
            { value: "all-access", label: "● accès complet" },
            { value: "selected", label: "◐ sélection" },
            { value: "none", label: "○ aucun" },
            { value: "denied", label: "⊘ retiré" },
          ]}
        />
        <Checkbox checked={onlyWithAccess} onChange={setOnlyWithAccess} label="Avec au moins un accès" />
        <span className="ml-auto text-[11px] text-muted">
          {filteredRows.length} ligne(s)
        </span>
      </div>

      <div className="scroll-thin overflow-x-auto">
        <table className="cell-grid w-full text-[11.5px]">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 min-w-[190px] bg-panel px-2 py-1.5 text-left text-[10.5px] uppercase tracking-wider text-muted">
                Sujet
              </th>
              {visibleUpstreams.map((u) => (
                <th key={u.id} className="min-w-[86px] bg-panel px-1.5 py-1.5 text-center">
                  <div className="mono text-[11px] font-semibold text-ink">{u.slug}</div>
                  <div className="text-[10px] font-normal text-muted">{u.toolCount} outils</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keyRows.length === 0 && roleRows.length === 0 ? (
              <tr>
                <td colSpan={visibleUpstreams.length + 1} className="px-3 py-8 text-center text-[12px] text-muted">
                  Aucun sujet ne correspond aux filtres.
                </td>
              </tr>
            ) : null}
            {keyRows.length > 0 ? (
              <tr>
                <td
                  colSpan={visibleUpstreams.length + 1}
                  className="bg-[hsl(var(--panel-2))] px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted"
                >
                  Clés ({keyRows.length})
                </td>
              </tr>
            ) : null}
            {keyRows.map((row) => (
              <MatrixRow key={"key-" + row.subjectId} row={row} upstreams={visibleUpstreams} onOpen={openCell} />
            ))}
            {roleRows.length > 0 ? (
              <tr>
                <td
                  colSpan={visibleUpstreams.length + 1}
                  className="bg-[hsl(var(--panel-2))] px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-muted"
                >
                  Rôles ({roleRows.length})
                </td>
              </tr>
            ) : null}
            {roleRows.map((row) => (
              <MatrixRow key={"role-" + row.subjectId} row={row} upstreams={visibleUpstreams} onOpen={openCell} />
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-line px-3 py-1.5 text-[11px] text-muted">
        {LEGEND.map((l) => (
          <span key={l.symbol}>
            <b className="text-ink">{l.symbol}</b> {l.label}
          </span>
        ))}
        <span className="ml-auto">Cliquez sur une cellule pour éditer les outils.</span>
      </div>

      <SlideOver
        open={panel !== null}
        onClose={() => setPanel(null)}
        title={
          panel ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone={panel.row.subjectType === "key" ? "accent" : "violet"}>{panel.row.subjectType === "key" ? "clé" : "rôle"}</Badge>
              {panel.row.label}
              <span className="text-muted">→</span>
              <span className="mono">{panel.upstream.slug}</span>
            </span>
          ) : (
            ""
          )
        }
        subtitle={panel ? panel.upstream.name + " · " + panel.upstream.toolCount + " outil(s)" : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPanel(null)}>
              Annuler
            </Button>
            <Button variant="primary" onClick={apply} disabled={busy}>
              {busy ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </>
        }
      >
        {panel ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  { value: "none", label: "Aucun accès" },
                  { value: "all", label: "Tous (y compris futurs)" },
                  { value: "selected", label: "Sélection" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setMode(opt.value)}
                  className={cn(
                    "rounded border px-2 py-1 text-[11.5px]",
                    mode === opt.value ? "border-accent bg-[hsl(var(--panel-3))] text-ink" : "border-line text-muted hover:text-ink",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {mode === "none" ? (
              <Callout tone="info">
                {panel.row.subjectType === "key"
                  ? "La clé n'a aucun droit propre sur ce MCP. Un rôle peut toutefois lui en donner — vérifiez l'onglet Droits de la clé."
                  : "Le rôle n'accorde rien sur ce MCP."}
              </Callout>
            ) : mode === "all" ? (
              <Callout tone="ok" title="Tous les outils, y compris ceux à venir">
                Un nouvel outil publié par {panel.upstream.slug} sera automatiquement autorisé pour ce sujet.
              </Callout>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <Input
                    className="h-7 py-1 text-[11.5px]"
                    placeholder="Rechercher un outil…"
                    value={toolSearch}
                    onChange={(e) => setToolSearch(e.target.value)}
                  />
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      const all = filteredTools.every((t) => tools.has(t.name));
                      const next = new Set(tools);
                      for (const t of filteredTools) {
                        if (all) next.delete(t.name);
                        else next.add(t.name);
                      }
                      setTools(next);
                    }}
                  >
                    {filteredTools.every((t) => tools.has(t.name)) ? "Tout décocher" : "Tout cocher"}
                  </Button>
                  <span className="shrink-0 text-[11px] text-muted">
                    {tools.size}/{panelTools.length}
                  </span>
                </div>
                <div className="scroll-thin max-h-[380px] overflow-y-auto rounded border border-line bg-[hsl(var(--bg))] p-1.5">
                  {filteredTools.length === 0 ? (
                    <p className="p-2 text-[11.5px] text-muted">Aucun outil listé (serveur non connecté ?).</p>
                  ) : (
                    filteredTools.map((t) => (
                      <div key={t.name} className="px-0.5 py-0.5">
                        <Checkbox
                          checked={tools.has(t.name)}
                          onChange={(next) => {
                            const set = new Set(tools);
                            if (next) set.add(t.name);
                            else set.delete(t.name);
                            setTools(set);
                          }}
                          label={
                            <span className="flex flex-wrap items-center gap-1">
                              <span className="mono text-[11.5px]">{t.name}</span>
                              {t.globallyDisabled ? <Badge tone="warn">désactivé</Badge> : null}
                            </span>
                          }
                          title={t.description ?? undefined}
                        />
                      </div>
                    ))
                  )}
                </div>
              </>
            )}

            {mode !== "none" ? (
              <div className="flex flex-wrap items-center gap-4 border-t border-line pt-2">
                <Checkbox checked={prompts} onChange={setPrompts} label={"Prompts (" + (editorFor?.promptCount ?? 0) + ")"} />
                <Checkbox checked={resources} onChange={setResources} label={"Ressources (" + (editorFor?.resourceCount ?? 0) + ")"} />
              </div>
            ) : null}

            {panel.row.subjectType === "key" && panel.row.denies && panel.row.denies.length > 0 ? (
              <Callout tone="warn" title="Retraits existants sur cette clé">
                {panel.row.denies.filter((d) => d.upstreamId === panel.upstream.id).length === 0
                  ? "Aucun retrait sur ce MCP."
                  : panel.row.denies
                      .filter((d) => d.upstreamId === panel.upstream.id)
                      .map((d) => (d.toolName === null ? "MCP entier" : d.toolName))
                      .join(", ")}
              </Callout>
            ) : null}
          </div>
        ) : null}
      </SlideOver>
    </div>
  );
}

function MatrixRow({
  row,
  upstreams,
  onOpen,
}: {
  row: MatrixRowData;
  upstreams: MatrixUpstream[];
  onOpen: (row: MatrixRowData, upstream: MatrixUpstream) => void;
}) {
  const deniedAll = new Set((row.denies ?? []).filter((d) => d.toolName === null).map((d) => d.upstreamId));
  return (
    <tr>
      <td className="sticky left-0 z-10 bg-panel px-2 py-1">
        <div className="flex items-center gap-1.5">
          <Badge tone={row.subjectType === "key" ? "accent" : "violet"}>{row.subjectType === "key" ? "K" : "R"}</Badge>
          <a href={(row.subjectType === "key" ? "/keys/" : "/roles/") + row.subjectId} className="truncate text-[12px] hover:underline">
            {row.label}
          </a>
        </div>
      </td>
      {upstreams.map((u) => {
        const cell = row.cells[u.id];
        const kind: CellKind = deniedAll.has(u.id) ? "denied" : (cell?.kind ?? "none");
        const display = deniedAll.has(u.id) ? "⊘" : cellSymbol(cell);
        return (
          <td key={u.id} className="p-0">
            <button
              type="button"
              onClick={() => onOpen(row, u)}
              className={cn(
                "flex h-full w-full items-center justify-center px-1 py-1.5 font-mono text-[11.5px] hover:bg-[hsl(var(--panel-3))]",
                cellClass({ kind }),
              )}
              title={u.slug + " · " + (cell ? (cell.kind === "all" ? "tous les outils" : cell.kind === "selected" ? cell.selected + "/" + cell.total + " outils" : "aucun accès") : "aucun accès")}
            >
              {display}
            </button>
          </td>
        );
      })}
    </tr>
  );
}
