"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/dialog";
import { Code, Mono, Spinner } from "@/components/ui/misc";
import { Switch } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorMessage } from "@/components/client-api";
import { cn } from "@/components/ui/cn";

export interface ItemRow {
  name: string;
  publicName: string;
  description: string | null;
  enabled: boolean;
  alias: string | null;
  descriptionOverride: string | null;
  truncated: boolean;
}

/**
 * Global per-item settings for one upstream tab (spec §8: "activer globalement, alias, description").
 * A global disable wins over every grant, so this panel is deliberately blunt about it.
 */
export function ItemOverridesPanel({
  upstreamId,
  kind,
  items,
}: {
  upstreamId: string;
  kind: "tool" | "prompt" | "resource";
  items: ItemRow[];
}) {
  const toast = useToast();
  const [rows, setRows] = React.useState(items);
  const [query, setQuery] = React.useState("");
  const [editing, setEditing] = React.useState<ItemRow | null>(null);
  const [alias, setAlias] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => setRows(items), [items]);

  const filtered = query
    ? rows.filter(
        (r) =>
          r.name.toLowerCase().includes(query.toLowerCase()) ||
          (r.description ?? "").toLowerCase().includes(query.toLowerCase()),
      )
    : rows;

  async function toggle(row: ItemRow, next: boolean) {
    setRows((prev) => prev.map((r) => (r.name === row.name ? { ...r, enabled: next } : r)));
    try {
      await apiRequest("/api/v1/upstreams/" + upstreamId + "/items/" + kind + "/" + encodeURIComponent(row.name), {
        method: "PUT",
        body: { enabled: next },
      });
      toast.push((next ? "Activé" : "Désactivé") + " globalement : " + row.name, next ? "ok" : "warn");
    } catch (err) {
      setRows((prev) => prev.map((r) => (r.name === row.name ? { ...r, enabled: !next } : r)));
      toast.push(errorMessage(err), "bad");
    }
  }

  function openEditor(row: ItemRow) {
    setEditing(row);
    setAlias(row.alias ?? "");
    setDescription(row.descriptionOverride ?? "");
  }

  async function saveEditor() {
    if (!editing) return;
    setBusy(true);
    try {
      await apiRequest("/api/v1/upstreams/" + upstreamId + "/items/" + kind + "/" + encodeURIComponent(editing.name), {
        method: "PUT",
        body: {
          alias: alias.trim() ? alias.trim() : null,
          descriptionOverride: description.trim() ? description.trim() : null,
        },
      });
      setRows((prev) =>
        prev.map((r) =>
          r.name === editing.name
            ? { ...r, alias: alias.trim() || null, descriptionOverride: description.trim() || null, description: description.trim() || r.description }
            : r,
        ),
      );
      toast.push("Personnalisation enregistrée.", "ok");
      setEditing(null);
    } catch (err) {
      toast.push(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function resetOverride(row: ItemRow) {
    try {
      await apiRequest("/api/v1/upstreams/" + upstreamId + "/items/" + kind + "/" + encodeURIComponent(row.name), {
        method: "DELETE",
      });
      setRows((prev) => prev.map((r) => (r.name === row.name ? { ...r, alias: null, descriptionOverride: null, enabled: true } : r)));
      toast.push("Personnalisation réinitialisée.", "info");
    } catch (err) {
      toast.push(errorMessage(err), "bad");
    }
  }

  const disabledCount = rows.filter((r) => !r.enabled).length;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Input
          className="h-7 max-w-[260px] py-1 text-[11.5px]"
          placeholder={kind === "tool" ? "Rechercher un outil…" : kind === "prompt" ? "Rechercher un prompt…" : "Rechercher une ressource…"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="text-[11px] text-muted">
          {filtered.length} / {rows.length}
        </span>
        {disabledCount > 0 ? <Badge tone="warn">{disabledCount} désactivé(s) globalement</Badge> : null}
      </div>

      {rows.length === 0 ? (
        <p className="px-3 py-6 text-center text-[12px] text-muted">
          Aucun élément. Le serveur n&apos;a encore rien publié pour ce type (ou n&apos;est pas connecté).
        </p>
      ) : (
        <div className="scroll-thin max-h-[560px] overflow-y-auto">
          {filtered.map((row) => (
            <div
              key={row.name}
              className={cn(
                "flex flex-wrap items-center gap-3 border-b border-line px-3 py-1.5 last:border-b-0",
                !row.enabled && "opacity-60",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Mono className="text-[11.5px] font-medium text-ink">{row.publicName}</Mono>
                  {row.alias ? <Badge tone="info">alias {row.alias}</Badge> : null}
                  {row.truncated ? <Badge tone="warn" title="Nom tronqué (limite 46 caractères) : proposer un alias">nom long</Badge> : null}
                  {row.descriptionOverride ? <Badge tone="violet">description réécrite</Badge> : null}
                  {!row.enabled ? <Badge tone="bad">désactivé</Badge> : null}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-muted" title={row.description ?? ""}>
                  {row.description ?? "sans description"}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Switch checked={row.enabled} onChange={(next) => toggle(row, next)} />
                <Button size="xs" variant="ghost" onClick={() => openEditor(row)}>
                  Personnaliser
                </Button>
                {row.alias || row.descriptionOverride ? (
                  <Button size="xs" variant="ghost" onClick={() => resetOverride(row)}>
                    Réinitialiser
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
          {filtered.length === 0 ? <p className="px-3 py-6 text-center text-[12px] text-muted">Aucun résultat.</p> : null}
        </div>
      )}

      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={"Personnaliser " + (editing?.publicName ?? "")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Annuler
            </Button>
            <Button variant="primary" onClick={saveEditor} disabled={busy}>
              {busy ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </>
        }
      >
        {editing ? (
          <div className="flex flex-col gap-3">
            <div>
              <span className="label">Nom public actuel</span>
              <Code>{editing.publicName}</Code>
              {editing.truncated ? (
                <p className="mt-1 text-[11px] text-warn">
                  Le nom dépasse la limite de 46 caractères. Un alias court évite d&apos;être tronqué côté client.
                </p>
              ) : null}
            </div>
            <div>
              <span className="label">Alias (remplace le nom dans le nom public)</span>
              <Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="creer_ticket" className="font-mono" />
              <p className="field-hint">Le préfixe &lt;slug&gt;__ reste appliqué. Laissez vide pour garder le nom d&apos;origine.</p>
            </div>
            <div>
              <span className="label">Description réécrite</span>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description affichée aux agents" />
              <p className="field-hint">Utile quand la description amont est trompeuse. Vide = description d&apos;origine.</p>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
