"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/dialog";
import { Callout } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorMessage } from "@/components/client-api";

const STATUSES = [
  { value: "new", label: "Nouveau" },
  { value: "acknowledged", label: "Acknowledgé" },
  { value: "in_progress", label: "En cours" },
  { value: "resolved", label: "Résolu" },
  { value: "wont_fix", label: "Wont fix" },
];

/** Status change + admin note for one feedback entry (spec §8 "changement de statut, note d'admin"). */
export function FeedbackDetailActions({
  id,
  status,
  adminNote,
}: {
  id: string;
  status: string;
  adminNote: string | null;
  category?: string;
  keyId?: string;
  toolName?: string | null;
  upstreamId?: string | null;
  upstreamSlug?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [nextStatus, setNextStatus] = React.useState(status);
  const [note, setNote] = React.useState(adminNote ?? "");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/api/v1/feedback/" + id, {
        method: "PATCH",
        body: { status: nextStatus, adminNote: note.trim() ? note.trim() : null },
      });
      toast.push("Retour mis à jour.", "ok");
      setOpen(false);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
        Changer le statut
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Traiter ce retour"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button variant="primary" onClick={save} disabled={busy}>
              {busy ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Callout tone="bad">{error}</Callout> : null}
          <Field label="Statut">
            <Select value={nextStatus} onChange={(e) => setNextStatus(e.target.value)} options={STATUSES} />
          </Field>
          <Field label="Note d'admin" hint="Visible dans la fiche et la liste. Les secrets connus sont masqués.">
            <Textarea rows={4} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Corrigé en v0.2 : le toolTimeout de jira a été augmenté." />
          </Field>
        </div>
      </Modal>
    </>
  );
}

/**
 * Category-specific quick actions (spec §8):
 * access_needed → grant the tool to the key (prefilled rights editor);
 * tool_error / slow → open the server sheet; bad_description → edit the tool description (override).
 */
export function QuickActions({
  category,
  keyId,
  toolName,
  upstreamId,
  upstreamSlug,
  serverName,
}: {
  category: string;
  keyId: string;
  toolName: string | null;
  upstreamId: string | null;
  upstreamSlug: string | null;
  serverName: string | null;
}) {
  const toast = useToast();
  const router = useRouter();
  const [grantOpen, setGrantOpen] = React.useState(false);
  const [descOpen, setDescOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [description, setDescription] = React.useState("");
  const [makeAll, setMakeAll] = React.useState(false);

  const originalName = toolName && toolName.includes("__") ? toolName.slice(toolName.indexOf("__") + 2) : toolName;

  async function grantAccess() {
    if (!upstreamId) {
      toast.push("MCP inconnu : impossible d'accorder l'outil automatiquement.", "warn");
      return;
    }
    setBusy(true);
    try {
      if (makeAll) {
        await apiRequest("/api/v1/grants", {
          method: "PUT",
          body: { subjectType: "key", subjectId: keyId, upstreamId, toolMode: "all", tools: [], prompts: false, resources: false },
        });
      } else {
        // Read the current own grant so we add the tool instead of replacing the selection.
        const detail = await apiRequest<{ ownGrants?: Array<{ upstreamId: string; toolMode: string; tools: string[]; prompts: boolean; resources: boolean }> }>(
          "/api/v1/keys/" + keyId,
        );
        const current = detail.ownGrants?.find((g) => g.upstreamId === upstreamId);
        const tools =
          current?.toolMode === "selected" ? Array.from(new Set([...(current.tools ?? []), originalName ?? ""])) : [originalName ?? ""];
        await apiRequest("/api/v1/grants", {
          method: "PUT",
          body: {
            subjectType: "key",
            subjectId: keyId,
            upstreamId,
            toolMode: "selected",
            tools: tools.filter(Boolean),
            prompts: current?.prompts ?? false,
            resources: current?.resources ?? false,
          },
        });
      }
      toast.push("Accès accordé. L'agent le voit immédiatement (list_changed) ou à sa prochaine session.", "ok");
      setGrantOpen(false);
      router.refresh();
    } catch (err) {
      toast.push(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function saveDescription() {
    if (!upstreamId || !originalName) return;
    setBusy(true);
    try {
      await apiRequest("/api/v1/upstreams/" + upstreamId + "/items/tool/" + encodeURIComponent(originalName), {
        method: "PUT",
        body: { descriptionOverride: description.trim() ? description.trim() : null },
      });
      toast.push("Description de l'outil mise à jour.", "ok");
      setDescOpen(false);
      router.refresh();
    } catch (err) {
      toast.push(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {upstreamId ? (
          <Link href={"/servers/" + upstreamId} className="btn btn-secondary btn-sm">
            Fiche du serveur{serverName ? " " + serverName : ""}
          </Link>
        ) : (
          <span className="text-[11.5px] text-muted">MCP inconnu ({upstreamSlug ?? "—"})</span>
        )}
        {toolName && upstreamId ? (
          <Link href={"/servers/" + upstreamId + "?tab=console&tool=" + encodeURIComponent(originalName ?? "")} className="btn btn-secondary btn-sm">
            Tester l&apos;outil
          </Link>
        ) : null}
      </div>

      {category === "access_needed" && toolName ? (
        <div className="rounded border border-line bg-[hsl(var(--bg))] p-2">
          <div className="text-[11.5px]">
            Accorder <span className="mono">{toolName}</span> à cette clé.
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <Button size="xs" variant="primary" onClick={() => setGrantOpen(true)}>
              Accorder cet outil
            </Button>
            <Link href={"/keys/" + keyId + "?tab=rights"} className="btn btn-ghost btn-xs">
              Ouvrir l&apos;éditeur complet
            </Link>
          </div>
        </div>
      ) : null}

      {(category === "tool_error" || category === "slow") && upstreamId ? (
        <Callout tone="info" title="Problème d'outil ou de lenteur">
          Vérifiez la santé du serveur, ses logs et le timeout d&apos;appel. La fiche serveur expose le stderr et la console de test.
        </Callout>
      ) : null}

      {category === "bad_description" && toolName ? (
        <div className="rounded border border-line bg-[hsl(var(--bg))] p-2">
          <div className="text-[11.5px]">Réécrire la description de <span className="mono">{toolName}</span>.</div>
          <div className="mt-1.5">
            <Button size="xs" onClick={() => setDescOpen(true)} disabled={!upstreamId}>
              Éditer la description
            </Button>
          </div>
        </div>
      ) : null}

      {category === "missing_tool" ? (
        <Callout tone="info" title="Outil manquant">
          Vérifiez que le MCP concerné est bien connecté et que l&apos;outil existe côté amont, puis accordez-le si nécessaire. S&apos;il n&apos;existe
          pas, ajoutez le serveur qui le fournit.
        </Callout>
      ) : null}

      <Modal
        open={grantOpen}
        onClose={() => setGrantOpen(false)}
        title="Accorder l'outil"
        footer={
          <>
            <Button variant="ghost" onClick={() => setGrantOpen(false)}>
              Annuler
            </Button>
            <Button variant="primary" onClick={grantAccess} disabled={busy}>
              {busy ? "Application…" : "Accorder"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <div className="text-[12px]">
            Clé : <b>{keyId}</b> · MCP : <span className="mono">{upstreamSlug}</span> · Outil : <span className="mono">{toolName}</span>
          </div>
          <Checkbox
            checked={makeAll}
            onChange={setMakeAll}
            label={"Accorder tous les outils de " + (upstreamSlug ?? "ce MCP") + " (y compris futurs)"}
          />
          <p className="text-[11.5px] text-muted">
            Sans cette case, l&apos;outil est ajouté à la sélection existante de la clé pour ce MCP. Les autres droits ne sont pas modifiés.
          </p>
        </div>
      </Modal>

      <Modal
        open={descOpen}
        onClose={() => setDescOpen(false)}
        title={"Description de " + (originalName ?? "")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDescOpen(false)}>
              Annuler
            </Button>
            <Button variant="primary" onClick={saveDescription} disabled={busy}>
              {busy ? "Enregistrement…" : "Enregistrer"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <Field label="Nouvelle description (override global)" hint="Vide = retour à la description amont.">
            <Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <p className="text-[11.5px] text-muted">Cet override s&apos;applique à toutes les clés qui voient cet outil.</p>
        </div>
      </Modal>
    </div>
  );
}
