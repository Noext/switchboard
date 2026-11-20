"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/dialog";
import { Callout } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorMessage } from "@/components/client-api";
import type { EditorUpstream, GrantState } from "@/components/access/access-editor";
import { AccessEditor } from "@/components/access/access-editor";

export function RoleActions({ roleId, name, description }: { roleId: string; name: string; description: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState<"edit" | "delete" | null>(null);
  const [newName, setNewName] = React.useState(name);
  const [newDescription, setNewDescription] = React.useState(description ?? "");
  const [busy, setBusy] = React.useState(false);

  async function save() {
    setBusy(true);
    try {
      await apiRequest("/api/v1/roles/" + roleId, {
        method: "PATCH",
        body: { name: newName.trim(), description: newDescription.trim() || null },
      });
      toast.push("Rôle mis à jour. Toutes ses clés sont notifiées.", "ok");
      setOpen(null);
      router.refresh();
    } catch (err) {
      toast.push(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await apiRequest("/api/v1/roles/" + roleId, { method: "DELETE" });
      toast.push("Rôle supprimé.", "ok");
      router.push("/roles");
      router.refresh();
    } catch (err) {
      toast.push(errorMessage(err), "bad");
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      <Button size="sm" onClick={() => setOpen("edit")}>
        Éditer
      </Button>
      <Button size="sm" variant="ghost" className="text-bad" onClick={() => setOpen("delete")}>
        Supprimer
      </Button>

      <Modal
        open={open === "edit"}
        onClose={() => setOpen(null)}
        title="Éditer le rôle"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(null)}>
              Annuler
            </Button>
            <Button variant="primary" onClick={save} disabled={busy || !newName.trim()}>
              Enregistrer
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Nom">
            <Input value={newName} onChange={(e) => setNewName(e.target.value)} />
          </Field>
          <Field label="Description">
            <Textarea rows={2} value={newDescription} onChange={(e) => setNewDescription(e.target.value)} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={open === "delete"}
        onClose={() => setOpen(null)}
        title={"Supprimer le rôle « " + name + " » ?"}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(null)}>
              Annuler
            </Button>
            <Button variant="danger" onClick={remove} disabled={busy}>
              Supprimer
            </Button>
          </>
        }
      >
        <Callout tone="warn" title="Les clés perdent les droits de ce rôle">
          Les droits propres des clés ne sont pas touchés, mais tout ce que ce rôle accordait disparaît immédiatement pour toutes ses clés.
        </Callout>
      </Modal>
    </div>
  );
}

export function RoleAccessTab({
  roleId,
  upstreams,
  grants,
}: {
  roleId: string;
  upstreams: EditorUpstream[];
  grants: GrantState[];
}) {
  return <AccessEditor subjectType="role" subjectId={roleId} upstreams={upstreams} grants={grants} />;
}

export function RoleKeysTab({
  roleId,
  keys,
  selected,
}: {
  roleId: string;
  keys: Array<{ id: string; name: string; status: string }>;
  selected: string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [set, setSet] = React.useState<string[]>(selected);
  const [dirty, setDirty] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  async function save() {
    setBusy(true);
    try {
      await apiRequest("/api/v1/roles/" + roleId + "/keys", { method: "PUT", body: { keyIds: set } });
      toast.push("Clés du rôle mises à jour.", "ok");
      setDirty(false);
      router.refresh();
    } catch (err) {
      toast.push(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setSet((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
    setDirty(true);
  }

  return (
    <div className="flex flex-col gap-3">
      {keys.length === 0 ? (
        <p className="text-[12px] text-muted">Aucune clé API existante.</p>
      ) : (
        <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center gap-2 rounded border border-line bg-[hsl(var(--bg))] px-2 py-1.5">
              <Checkbox
                checked={set.includes(k.id)}
                onChange={() => toggle(k.id)}
                label={
                  <span className="flex items-center gap-1.5">
                    {k.name}
                    <Badge tone={k.status === "active" ? "ok" : k.status === "revoked" ? "bad" : "warn"}>{k.status}</Badge>
                  </span>
                }
              />
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-end">
        <Button variant={dirty ? "primary" : "ghost"} onClick={save} disabled={!dirty || busy}>
          {busy ? "Enregistrement…" : dirty ? "Appliquer aux " + set.length + " clé(s)" : "À jour"}
        </Button>
      </div>
    </div>
  );
}
