"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Textarea } from "@/components/ui/input";
import { Modal } from "@/components/ui/dialog";
import { Callout } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorMessage } from "@/components/client-api";

export function RoleCreateForm({ keyChoices }: { keyChoices: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [keyIds, setKeyIds] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiRequest<{ role?: { id: string } }>("/api/v1/roles", {
        method: "POST",
        body: { name: name.trim(), description: description.trim() || null, keyIds },
      });
      toast.push("Rôle créé.", "ok");
      setOpen(false);
      const id = res.role?.id;
      if (id) router.push("/roles/" + id);
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
        Créer un rôle
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Nouveau rôle"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button variant="primary" onClick={submit} disabled={busy || !name.trim()}>
              {busy ? "Création…" : "Créer"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          {error ? <Callout tone="bad">{error}</Callout> : null}
          <Field label="Nom" hint="Ex. dev-wegrow, recherche.">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="dev-wegrow" />
          </Field>
          <Field label="Description">
            <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Droits communs aux agents de développement." />
          </Field>
          {keyChoices.length > 0 ? (
            <Field label="Clés utilisant ce rôle">
              <div className="scroll-thin flex max-h-[160px] flex-col gap-1 overflow-y-auto">
                {keyChoices.map((k) => (
                  <Checkbox
                    key={k.id}
                    checked={keyIds.includes(k.id)}
                    onChange={(next) => setKeyIds((prev) => (next ? [...prev, k.id] : prev.filter((x) => x !== k.id)))}
                    label={k.name}
                  />
                ))}
              </div>
            </Field>
          ) : null}
          <p className="text-[11px] text-muted">Les droits du rôle se configurent sur sa fiche, juste après la création.</p>
        </div>
      </Modal>
    </>
  );
}
