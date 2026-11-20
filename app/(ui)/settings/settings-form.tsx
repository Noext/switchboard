"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Field, Input, Switch } from "@/components/ui/input";
import { Callout, Spinner } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorMessage } from "@/components/client-api";

export interface SettingsValues {
  publicUrl: string;
  feedbackEnabled: boolean;
  appriseUrl: string;
  appriseEnabled: boolean;
  logRetentionDays: number;
  logRetentionRows: number;
  discoveryThreshold: number;
}

export function SettingsForm({ initial, envPublicUrl }: { initial: SettingsValues; envPublicUrl: string }) {
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = React.useState<SettingsValues>(initial);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const set = <K extends keyof SettingsValues>(key: K, value: SettingsValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiRequest("/api/v1/settings", {
        method: "PATCH",
        body: {
          publicUrl: values.publicUrl.trim(),
          feedbackEnabled: values.feedbackEnabled,
          appriseUrl: values.appriseUrl.trim(),
          appriseEnabled: values.appriseEnabled,
          logRetentionDays: Number(values.logRetentionDays) || 30,
          logRetentionRows: Number(values.logRetentionRows) || 100000,
          discoveryThreshold: Number(values.discoveryThreshold) || 60,
        },
      });
      toast.push("Paramètres enregistrés.", "ok");
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      toast.push(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3">
      {error ? <Callout tone="bad">{error}</Callout> : null}

      <Card>
        <CardHeader title="Accès et URL" subtitle="Base des snippets d'installation et des callbacks OAuth." />
        <CardBody className="flex flex-col gap-3">
          <Field
            label="URL publique"
            htmlFor="publicUrl"
            hint={"Laissez vide pour utiliser la variable d'environnement (" + envPublicUrl + "). Doit être en HTTPS pour les callbacks OAuth."}
          >
            <Input
              id="publicUrl"
              value={values.publicUrl}
              onChange={(e) => set("publicUrl", e.target.value)}
              placeholder="https://switchboard.example.com"
              className="font-mono"
            />
          </Field>
          <div className="rounded border border-line bg-[hsl(var(--bg))] px-2.5 py-1.5">
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-muted">Endpoint MCP résultant</div>
            <div className="mono mt-0.5 text-[12px]">
              {(values.publicUrl || envPublicUrl).replace(/\/$/, "")}
              <span className="text-accent">/mcp</span>
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Retours des agents" subtitle="Outil report_feedback, disponible pour chaque clé agent." />
        <CardBody className="flex flex-col gap-3">
          <Switch
            checked={values.feedbackEnabled}
            onChange={(next) => set("feedbackEnabled", next)}
            label="Activer report_feedback (recommandé)"
          />
          <p className="text-[11.5px] text-muted">
            Toujours visible pour les clés agent, même sans aucun droit et en mode découverte. Le désactiver prive la passerelle du seul canal de
            retour des agents.
          </p>
          <div className="border-t border-line pt-3">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted">Notification Apprise</div>
            <div className="flex flex-col gap-2">
              <Switch
                checked={values.appriseEnabled}
                onChange={(next) => set("appriseEnabled", next)}
                label="Notifier les retours high / blocking"
              />
              <Field label="URL Apprise" htmlFor="appriseUrl" hint="Endpoint complet de l'API Apprise, ex. http://apprise.local:8000/notify/switchboard">
                <Input
                  id="appriseUrl"
                  value={values.appriseUrl}
                  onChange={(e) => set("appriseUrl", e.target.value)}
                  placeholder="http://…:8000/notify/switchboard"
                  className="font-mono"
                />
              </Field>
              {values.appriseEnabled && !values.appriseUrl.trim() ? (
                <Callout tone="warn">Une URL Apprise est requise pour que la notification fonctionne.</Callout>
              ) : null}
            </div>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Rétention et découverte" />
        <CardBody className="grid gap-3 sm:grid-cols-2">
          <Field label="Rétention (jours)" htmlFor="retentionDays" hint="Purge des call_logs au-delà.">
            <Input
              id="retentionDays"
              type="number"
              min={1}
              max={3650}
              value={values.logRetentionDays}
              onChange={(e) => set("logRetentionDays", Number(e.target.value))}
            />
          </Field>
          <Field label="Rétention (lignes)" htmlFor="retentionRows" hint="Le premier des deux seuils atteint déclenche la purge.">
            <Input
              id="retentionRows"
              type="number"
              min={1000}
              max={10000000}
              step={1000}
              value={values.logRetentionRows}
              onChange={(e) => set("logRetentionRows", Number(e.target.value))}
            />
          </Field>
          <Field
            label="Seuil du mode découverte"
            htmlFor="discoveryThreshold"
            hint="Au-delà de ce nombre d'outils visibles pour une clé en mode direct, les clients basculent en découverte."
            className="sm:col-span-2"
          >
            <Input
              id="discoveryThreshold"
              type="number"
              min={1}
              max={10000}
              value={values.discoveryThreshold}
              onChange={(e) => set("discoveryThreshold", Number(e.target.value))}
              className="max-w-[180px]"
            />
          </Field>
        </CardBody>
      </Card>

      <div className="flex items-center justify-end gap-2">
        {saved ? <span className="text-[11.5px] text-ok">Enregistré.</span> : null}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? <Spinner /> : null}
          {busy ? "Enregistrement…" : "Enregistrer les paramètres"}
        </Button>
      </div>
    </form>
  );
}
