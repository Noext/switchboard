"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Input } from "@/components/ui/input";
import { Mono, Spinner } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorMessage } from "@/components/client-api";
import { cn } from "@/components/ui/cn";

/** Shapes mirrored from components/server/access-data.ts (serialisable props). */
export interface EditorTool {
  name: string;
  publicName: string;
  description: string | null;
  globallyDisabled: boolean;
}

export interface EditorUpstream {
  id: string;
  slug: string;
  name: string;
  status: string;
  enabled: boolean;
  tools: EditorTool[];
  promptCount: number;
  resourceCount: number;
}

export interface GrantState {
  upstreamId: string;
  mode: "all" | "selected";
  tools: string[];
  prompts: boolean;
  resources: boolean;
}

export interface ToolOrigin {
  own: boolean;
  roles: string[];
}

export interface OriginData {
  origins: Record<string, Record<string, ToolOrigin>>;
  denies: Array<{ upstreamId: string; toolName: string | null }>;
}

interface DraftGrant {
  mode: "none" | "all" | "selected";
  tools: Set<string>;
  prompts: boolean;
  resources: boolean;
  grantId: string | null;
  dirty: boolean;
}

type Mode = "none" | "all" | "selected";

function emptyDraft(): DraftGrant {
  return { mode: "none", tools: new Set(), prompts: false, resources: false, grantId: null, dirty: false };
}

export interface AccessEditorProps {
  subjectType: "key" | "role";
  subjectId: string;
  upstreams: EditorUpstream[];
  /** Current grants of the subject. */
  grants: GrantState[];
  /** Only for keys: per-tool origin (own / roles) + current denies. */
  origins?: OriginData | null;
  /** Server "Accès" tab variant: show the subject label instead of the rights header. */
  compact?: boolean;
  /** Wizard mode: never call the API, only report the draft grants through onLocalChange. */
  localOnly?: boolean;
  onLocalChange?: (grants: GrantState[]) => void;
}

/**
 * The rights editor shared by the key fiche, the role fiche and the matrix side panel
 * (spec §8: accordion per MCP, selectors Aucun / Tous / Sélection, per-tool checkboxes with
 * origin badges, per-key removal, prompts/resources toggles).
 */
export function AccessEditor({
  subjectType,
  subjectId,
  upstreams,
  grants,
  origins,
  compact,
  localOnly = false,
  onLocalChange,
}: AccessEditorProps) {
  const toast = useToast();
  const [drafts, setDrafts] = React.useState<Record<string, DraftGrant>>(() => {
    const initial: Record<string, DraftGrant> = {};
    for (const u of upstreams) initial[u.id] = emptyDraft();
    for (const g of grants) {
      initial[g.upstreamId] = {
        mode: g.mode,
        tools: new Set(g.tools),
        prompts: g.prompts,
        resources: g.resources,
        grantId: null,
        dirty: false,
      };
    }
    return initial;
  });
  const [open, setOpen] = React.useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const g of grants) initial[g.upstreamId] = true;
    return initial;
  });
  const [search, setSearch] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState<string | null>(null);
  const [denyList, setDenyList] = React.useState<Array<{ upstreamId: string; toolName: string | null }>>(
    () => origins?.denies ?? [],
  );

  const isKey = subjectType === "key";

  // Wizard mode: mirror the draft grants to the parent so it can POST them with the key.
  React.useEffect(() => {
    if (!localOnly || !onLocalChange) return;
    const next: GrantState[] = [];
    for (const upstream of upstreams) {
      const draft = drafts[upstream.id];
      if (!draft || draft.mode === "none") continue;
      next.push({
        upstreamId: upstream.id,
        mode: draft.mode,
        tools: Array.from(draft.tools).sort(),
        prompts: draft.prompts,
        resources: draft.resources,
      });
    }
    onLocalChange(next);
    // onLocalChange is a stable setter in the wizard; drafts/upstreams drive the update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, upstreams, localOnly]);
  const deniedSet = React.useMemo(() => {
    const map = new Map<string, Set<string>>();
    const all = new Set<string>();
    for (const deny of denyList) {
      if (deny.toolName === null) {
        all.add(deny.upstreamId);
        continue;
      }
      const set = map.get(deny.upstreamId) ?? new Set<string>();
      set.add(deny.toolName);
      map.set(deny.upstreamId, set);
    }
    return { tools: map, all };
  }, [denyList]);

  function update(upstreamId: string, patch: Partial<DraftGrant>) {
    setDrafts((prev) => {
      const current = prev[upstreamId] ?? emptyDraft();
      return { ...prev, [upstreamId]: { ...current, ...patch, dirty: true } };
    });
  }

  function setMode(upstreamId: string, mode: Mode) {
    const draft = drafts[upstreamId] ?? emptyDraft();
    if (mode === "selected" && draft.tools.size === 0) {
      // Pre-fill the selection with what the subject already sees, to avoid an accidental wipe.
      const existing = grants.find((g) => g.upstreamId === upstreamId);
      const tools = new Set(existing?.tools ?? []);
      update(upstreamId, { mode, tools });
      return;
    }
    update(upstreamId, { mode });
  }

  function toggleTool(upstreamId: string, toolName: string, next: boolean) {
    const draft = drafts[upstreamId] ?? emptyDraft();
    const tools = new Set(draft.tools);
    if (next) tools.add(toolName);
    else tools.delete(toolName);
    update(upstreamId, { tools, mode: draft.mode === "none" ? "selected" : draft.mode });
  }

  async function save(upstream: EditorUpstream) {
    const draft = drafts[upstream.id] ?? emptyDraft();
    if (localOnly) {
      // Nothing to persist yet: the wizard sends these rights with the key.
      update(upstream.id, { dirty: false });
      return;
    }
    setSaving(upstream.id);
    try {
      if (draft.mode === "none") {
        // Removing a grant: delete the existing grant row if there was one.
        const existing = grants.find((g) => g.upstreamId === upstream.id);
        if (existing) {
          // Grant ids are not in the serialisable state; resolve through the matrix endpoint.
          const matrix = await apiRequest<{ row?: { cells: Record<string, { grantId?: string }> } }>(
            isKey ? "/api/v1/keys/" + subjectId + "/access" : "/api/v1/access-matrix?subject=role",
          );
          const grantId = matrix.row?.cells?.[upstream.id]?.grantId;
          if (grantId) {
            await apiRequest("/api/v1/grants/" + grantId, { method: "DELETE" });
          } else {
            // Fall back to wiping the grant through an empty "selected" upsert.
            await apiRequest("/api/v1/grants", {
              method: "PUT",
              body: {
                subjectType,
                subjectId,
                upstreamId: upstream.id,
                toolMode: "selected",
                tools: [],
                prompts: false,
                resources: false,
              },
            });
          }
        }
      } else {
        await apiRequest("/api/v1/grants", {
          method: "PUT",
          body: {
            subjectType,
            subjectId,
            upstreamId: upstream.id,
            toolMode: draft.mode,
            tools: draft.mode === "selected" ? Array.from(draft.tools) : [],
            prompts: draft.prompts,
            resources: draft.resources,
          },
        });
      }
      update(upstream.id, { dirty: false });
      toast.push("Droits enregistrés pour " + upstream.slug + ".", "ok");
      window.location.reload();
    } catch (err) {
      toast.push(errorMessage(err), "bad");
    } finally {
      setSaving(null);
    }
  }

  async function applyDenies(next: Array<{ upstreamId: string; toolName: string | null }>) {
    if (!isKey) return;
    setDenyList(next);
    try {
      await apiRequest("/api/v1/keys/" + subjectId + "/denies", { method: "PUT", body: { denies: next } });
    } catch (err) {
      toast.push(errorMessage(err), "bad");
    }
  }

  function toggleDeny(upstreamId: string, toolName: string) {
    const current = denyList.some((d) => d.upstreamId === upstreamId && d.toolName === toolName);
    const next = current
      ? denyList.filter((d) => !(d.upstreamId === upstreamId && d.toolName === toolName))
      : [...denyList.filter((d) => !(d.upstreamId === upstreamId && d.toolName === null)), { upstreamId, toolName }];
    void applyDenies(next);
  }

  function toggleDenyUpstream(upstreamId: string) {
    const wholeDenied = deniedSet.all.has(upstreamId);
    const next = wholeDenied
      ? denyList.filter((d) => d.upstreamId !== upstreamId)
      : [...denyList.filter((d) => d.upstreamId !== upstreamId), { upstreamId, toolName: null }];
    void applyDenies(next);
  }

  if (upstreams.length === 0) {
    return (
      <div className="rounded-md border border-line bg-[hsl(var(--bg))] px-3 py-6 text-center text-[12px] text-muted">
        Aucun MCP dans le catalogue. Ajoutez un serveur pour pouvoir attribuer des droits.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {upstreams.map((upstream) => {
        const draft = drafts[upstream.id] ?? emptyDraft();
        const existingGrant = grants.find((g) => g.upstreamId === upstream.id);
        const isOpen = open[upstream.id] ?? false;
        const filter = (search[upstream.id] ?? "").toLowerCase();
        const visibleTools = filter
          ? upstream.tools.filter(
              (t) => t.name.toLowerCase().includes(filter) || (t.description ?? "").toLowerCase().includes(filter),
            )
          : upstream.tools;
        const denyTools = deniedSet.tools.get(upstream.id) ?? new Set<string>();
        const wholeDenied = deniedSet.all.has(upstream.id);
        const originMap = origins?.origins?.[upstream.id] ?? {};
        const selectedCount = upstream.tools.filter((t) => draft.tools.has(t.name)).length;
        const allSelected = upstream.tools.length > 0 && selectedCount === upstream.tools.length;
        const inheritedOnly = existingGrant === undefined && Object.keys(originMap).some((n) => (originMap[n]?.roles.length ?? 0) > 0);

        return (
          <div key={upstream.id} className="overflow-hidden rounded-md border border-line bg-[hsl(var(--panel-2))]">
            <div className="flex flex-wrap items-center gap-2 px-2.5 py-2">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() => setOpen((prev) => ({ ...prev, [upstream.id]: !isOpen }))}
                aria-expanded={isOpen}
              >
                <span className={cn("shrink-0 text-[10px] text-muted transition-transform", isOpen && "rotate-90")}>▶</span>
                <span className="mono shrink-0 text-[12px] font-semibold text-ink">{upstream.slug}</span>
                <span className="min-w-0 truncate text-[11.5px] text-muted">{upstream.name}</span>
                <span className="shrink-0 text-[10.5px] text-muted">{upstream.tools.length} outils</span>
                {upstream.status !== "ready" ? <Badge tone="warn">{upstream.status}</Badge> : null}
                {wholeDenied ? <Badge tone="bad">⊘ retiré</Badge> : null}
                {inheritedOnly && draft.mode === "none" ? <Badge tone="violet">via rôle</Badge> : null}
              </button>

              <Segmented
                value={draft.mode}
                onChange={(next) => setMode(upstream.id, next as Mode)}
                options={[
                  { value: "none", label: "Aucun" },
                  { value: "all", label: "Tous" },
                  { value: "selected", label: "Sélection" },
                ]}
              />
              <Button size="xs" variant={draft.dirty ? "primary" : "ghost"} disabled={!draft.dirty || saving === upstream.id} onClick={() => save(upstream)}>
                {localOnly ? (draft.dirty ? "Pris en compte" : "À jour") : saving === upstream.id ? "…" : draft.dirty ? "Enregistrer" : "À jour"}
              </Button>
            </div>

            {isOpen ? (
              <div className="border-t border-line px-2.5 py-2">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <Input
                    className="h-7 max-w-[220px] py-1 text-[11.5px]"
                    placeholder="Rechercher un outil…"
                    value={search[upstream.id] ?? ""}
                    onChange={(e) => setSearch((prev) => ({ ...prev, [upstream.id]: e.target.value }))}
                  />
                  {draft.mode === "selected" ? (
                    <>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          update(upstream.id, {
                            tools: allSelected ? new Set<string>() : new Set(upstream.tools.map((t) => t.name)),
                          })
                        }
                      >
                        {allSelected ? "Tout décocher" : "Tout cocher"}
                      </Button>
                      <span className="text-[11px] text-muted">
                        {selectedCount}/{upstream.tools.length} sélectionné(s)
                      </span>
                    </>
                  ) : null}
                  {isKey && !localOnly ? (
                    <Button size="xs" variant="ghost" onClick={() => toggleDenyUpstream(upstream.id)}>
                      {wholeDenied ? "Rétablir ce MCP" : "⊘ Retirer ce MCP pour cette clé"}
                    </Button>
                  ) : null}
                  <div className="ml-auto flex items-center gap-3">
                    <Checkbox
                      checked={draft.prompts}
                      onChange={(next) => update(upstream.id, { prompts: next })}
                      label={"Prompts (" + upstream.promptCount + ")"}
                    />
                    <Checkbox
                      checked={draft.resources}
                      onChange={(next) => update(upstream.id, { resources: next })}
                      label={"Ressources (" + upstream.resourceCount + ")"}
                    />
                  </div>
                </div>

                {upstream.tools.length === 0 ? (
                  <p className="text-[11.5px] text-muted">
                    Ce serveur n&apos;a encore publié aucun outil. En mode « Tous », les outils qui apparaîtront plus tard seront
                    accordés automatiquement.
                  </p>
                ) : draft.mode === "all" ? (
                  <p className="text-[11.5px] text-muted">
                    Tous les outils actuels <b>et futurs</b> de ce MCP sont accordés. Aucune coche à faire.
                  </p>
                ) : (
                  <div className="scroll-thin max-h-[300px] overflow-y-auto">
                    <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
                      {visibleTools.map((tool) => {
                        const origin = originMap[tool.name];
                        const checked = draft.mode === "selected" && draft.tools.has(tool.name);
                        const denied = denyTools.has(tool.name);
                        return (
                          <div
                            key={tool.name}
                            className={cn(
                              "flex items-start gap-2 rounded px-1 py-1 hover:bg-[hsla(0,0%,100%,0.03)]",
                              denied && "opacity-50",
                            )}
                          >
                            <Checkbox
                              checked={checked}
                              onChange={(next) => toggleTool(upstream.id, tool.name, next)}
                              className="mt-0.5"
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-1">
                                <Mono className="text-[11.5px] text-ink">{tool.name}</Mono>
                                {origin?.own ? <Badge tone="accent">propre</Badge> : null}
                                {origin?.roles.map((role) => (
                                  <Badge key={role} tone="violet">
                                    rôle {role}
                                  </Badge>
                                ))}
                                {isKey && denied ? <Badge tone="bad">retiré</Badge> : null}
                                {tool.globallyDisabled ? <Badge tone="warn">désactivé globalement</Badge> : null}
                              </div>
                              {tool.description ? (
                                <div className="truncate text-[11px] text-muted" title={tool.description}>
                                  {tool.description}
                                </div>
                              ) : null}
                            </div>
                            {isKey && !localOnly && origin && (origin.own || origin.roles.length > 0) ? (
                              <button
                                type="button"
                                className="shrink-0 rounded px-1 text-[10.5px] text-muted hover:text-bad"
                                title={denied ? "Rétablir cet outil" : "Retirer cet outil à cette clé"}
                                onClick={() => toggleDeny(upstream.id, tool.name)}
                              >
                                {denied ? "↺" : "⊘"}
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                    {visibleTools.length === 0 ? <p className="text-[11.5px] text-muted">Aucun outil ne correspond.</p> : null}
                  </div>
                )}
              </div>
            ) : null}
          </div>
        );
      })}
      <div className="mt-1 flex flex-wrap items-center gap-3 text-[11px] text-muted">
        <span>
          <b className="text-ink">●</b> tous les outils
        </span>
        <span>
          <b className="text-ink">◐</b> sélection
        </span>
        <span>
          <b className="text-ink">○</b> aucun accès
        </span>
        {isKey ? (
          <span>
            <b className="text-ink">⊘</b> retiré pour cette clé
          </span>
        ) : null}
        {compact ? null : <span className="ml-auto">Le retrait l&apos;emporte toujours sur un ajout.</span>}
      </div>
    </div>
  );
}

export function AccessEditorLoading() {
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted">
      <Spinner /> chargement des droits…
    </div>
  );
}