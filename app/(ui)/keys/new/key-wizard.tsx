"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { Callout, Code, Mono, Spinner } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorMessage } from "@/components/client-api";
import { cn } from "@/components/ui/cn";
import type { EditorUpstream, GrantState } from "@/components/access/access-editor";
import { AccessEditor } from "@/components/access/access-editor";

interface RoleChoice {
  id: string;
  name: string;
  description: string | null;
}

interface InstallPayload {
  url: string;
  keyName: string;
  prefix: string;
  secret: string | null;
  markdown: string;
  json: string;
  claudeCodeCommand: string;
  codexConfig: string;
  allowed: Array<{ slug: string; name: string; tools: string[] }>;
}

interface CreateResponse {
  key: { id: string; name: string; prefix: string } | null;
  secret: string;
  install?: InstallPayload;
}

const STEPS = ["Identité", "Droits", "Récapitulatif"] as const;

/**
 * 3-step key creation wizard (spec §8 "Clés API": identité → droits → récap + clé affichée une
 * fois + snippets + INSTALL-<nom>.md). The secret only exists in the POST response, so the final
 * step renders it from local state — nothing is re-fetched.
 */
export function KeyWizard({
  roles,
  upstreams,
  copyableKeys,
}: {
  roles: RoleChoice[];
  upstreams: EditorUpstream[];
  copyableKeys: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [step, setStep] = React.useState(0);

  const [name, setName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [scope, setScope] = React.useState<"agent" | "admin">("agent");
  const [exposureMode, setExposureMode] = React.useState<"direct" | "discovery">("direct");
  const [expiresAt, setExpiresAt] = React.useState("");
  const [roleIds, setRoleIds] = React.useState<string[]>([]);

  // Step 2: rights. A temporary subject id is used so the shared editor works before the key exists.
  const DRAFT_ID = "draft-key";
  const [draftGrants, setDraftGrants] = React.useState<GrantState[]>([]);
  const [copyFrom, setCopyFrom] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [created, setCreated] = React.useState<CreateResponse | null>(null);

  const draftUpstreams = React.useMemo(() => upstreams, [upstreams]);

  function toggleRole(id: string) {
    setRoleIds((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim() || null,
        scope,
        exposureMode,
        roleIds,
        grants: draftGrants.map((g) => ({
          upstreamId: g.upstreamId,
          toolMode: g.mode,
          tools: g.mode === "selected" ? g.tools : [],
          prompts: g.prompts,
          resources: g.resources,
        })),
      };
      if (expiresAt) body.expiresAt = new Date(expiresAt + "T23:59:59").getTime();
      if (copyFrom) body.copyFromKeyId = copyFrom;

      const res = await apiRequest<CreateResponse>("/api/v1/keys?include=install", { method: "POST", body });
      setCreated(res);
      setStep(2);
      toast.push("Clé créée — copiez le secret maintenant.", "ok");
    } catch (err) {
      setError(errorMessage(err));
      toast.push(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return <CreatedKeyPanel created={created} onDone={() => router.push("/keys")} />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5">
        {STEPS.map((label, i) => (
          <React.Fragment key={label}>
            {i > 0 ? <div className={cn("h-px flex-1", i <= step ? "bg-accent" : "bg-line")} /> : null}
            <button
              type="button"
              onClick={() => i < step && setStep(i)}
              disabled={i > step}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px]",
                i === step ? "border-accent bg-[hsl(var(--panel-3))] text-ink" : i < step ? "border-line text-ink" : "border-line text-muted",
              )}
            >
              <span
                className={cn(
                  "flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold",
                  i <= step ? "bg-accent text-[hsl(var(--accent-ink))]" : "bg-[hsl(var(--panel-3))] text-muted",
                )}
              >
                {i + 1}
              </span>
              {label}
            </button>
          </React.Fragment>
        ))}
      </div>

      {error ? <Callout tone="bad">{error}</Callout> : null}

      {step === 0 ? (
        <Card>
          <CardHeader title="1 · Identité" subtitle="Le nom est unique (un agent = une clé)." />
          <CardBody className="grid gap-3 sm:grid-cols-2">
            <Field label="Nom" htmlFor="name" hint="Ex. claude-laptop, claude-box-wg, codex-perso.">
              <Input id="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="claude-laptop" />
            </Field>
            <Field label="Expiration (optionnel)" htmlFor="expires">
              <Input id="expires" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </Field>
            <Field label="Description" htmlFor="description" className="sm:col-span-2">
              <Textarea id="description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Clé utilisée par Claude Code sur la machine de dev." />
            </Field>
            <Field label="Portée" htmlFor="scope" hint="admin = accès à l'API d'administration, jamais aux outils.">
              <Select
                id="scope"
                value={scope}
                onChange={(e) => setScope(e.target.value as "agent" | "admin")}
                options={[
                  { value: "agent", label: "agent — utilise les outils via /mcp" },
                  { value: "admin", label: "admin — API d'administration" },
                ]}
              />
            </Field>
            <Field label="Mode d'exposition" htmlFor="exposure" hint="discovery remplace le listing par search_tools / describe_tool / call_tool.">
              <Select
                id="exposure"
                value={exposureMode}
                onChange={(e) => setExposureMode(e.target.value as "direct" | "discovery")}
                options={[
                  { value: "direct", label: "direct — tous les outils autorisés sont listés" },
                  { value: "discovery", label: "discovery — 3 méta-outils" },
                ]}
              />
            </Field>
            <Field label="Rôles" htmlFor="roles" className="sm:col-span-2" hint="Les droits des rôles s'appliquent immédiatement et à toutes leurs clés.">
              <div className="flex flex-wrap gap-1.5">
                {roles.length === 0 ? (
                  <span className="text-[12px] text-muted">
                    Aucun rôle.{" "}
                    <Link href="/roles" className="link">
                      Créer un rôle
                    </Link>
                  </span>
                ) : (
                  roles.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => toggleRole(r.id)}
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[11.5px] transition-colors",
                        roleIds.includes(r.id) ? "border-accent bg-[hsl(var(--panel-3))] text-ink" : "border-line text-muted hover:text-ink",
                      )}
                      title={r.description ?? undefined}
                    >
                      {roleIds.includes(r.id) ? "✓ " : ""}
                      {r.name}
                    </button>
                  ))
                )}
              </div>
            </Field>
            {copyableKeys.length > 0 ? (
              <Field label="Copier les droits de…" htmlFor="copyFrom" className="sm:col-span-2" hint="Duplique les rôles, droits propres et retraits de la clé choisie.">
                <Select
                  id="copyFrom"
                  value={copyFrom}
                  onChange={(e) => setCopyFrom(e.target.value)}
                  placeholder="— aucun —"
                  options={copyableKeys.map((k) => ({ value: k.id, label: k.name }))}
                />
              </Field>
            ) : null}
          </CardBody>
        </Card>
      ) : null}

      {step === 1 ? (
        <Card>
          <CardHeader
            title="2 · Droits initiaux"
            subtitle="Aucun droit par défaut. Vous pourrez tout ajuster après création."
          />
          <CardBody>
            {scope === "admin" ? (
              <Callout tone="warn" title="Clé administrateur">
                Une clé <span className="mono">admin</span> ne sert qu&apos;à l&apos;API d&apos;administration : elle est refusée sur /mcp et n&apos;a
                pas besoin de droits sur les outils.
              </Callout>
            ) : (
              <AccessEditor
                subjectType="key"
                subjectId={DRAFT_ID}
                upstreams={draftUpstreams}
                grants={draftGrants}
                onLocalChange={(grants) => setDraftGrants(grants)}
                localOnly
              />
            )}
          </CardBody>
        </Card>
      ) : null}

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={() => (step === 0 ? router.push("/keys") : setStep(step - 1))}>
          {step === 0 ? "Annuler" : "Retour"}
        </Button>
        <div className="flex items-center gap-2">
          {step === 1 || step === 2 ? (
            <Button variant="secondary" onClick={submit} disabled={busy || !name.trim()}>
              {busy ? "Création…" : "Créer la clé"}
            </Button>
          ) : null}
          {step === 0 ? (
            <Button variant="primary" onClick={() => setStep(1)} disabled={!name.trim()}>
              Suivant — droits
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function CreatedKeyPanel({ created, onDone }: { created: CreateResponse; onDone: () => void }) {
  const toast = useToast();
  const [revealed, setRevealed] = React.useState(false);
  const secret = created.secret;

  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.push(label + " copié.", "ok");
    } catch {
      toast.push("Copie impossible : sélectionnez le texte manuellement.", "warn");
    }
  }

  function downloadInstall() {
    const blob = new Blob([created.install?.markdown ?? ""], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "INSTALL-" + (created.install?.keyName ?? created.key?.name ?? "key") + ".md";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-3">
      <Callout tone="warn" title="Le secret ne sera plus jamais affiché">
        Copiez-le maintenant et remettez-le à l&apos;agent concerné. Switchboard ne stocke qu&apos;un hash : ni vous ni l&apos;API ne pourrez le
        retrouver. En cas de perte, utilisez la rotation depuis la fiche de la clé.
      </Callout>

      <Card>
        <CardHeader
          title="Clé créée"
          actions={
            <>
              <Button size="xs" variant="ghost" onClick={() => setRevealed((v) => !v)}>
                {revealed ? "Masquer" : "Afficher"}
              </Button>
              <Button size="xs" onClick={() => copy(secret, "Secret")}>
                Copier le secret
              </Button>
            </>
          }
        />
        <CardBody className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="ok">active</Badge>
            <span className="text-[12.5px] font-medium">{created.key?.name}</span>
            <span className="mono text-[11px] text-muted">{created.key?.prefix}…</span>
          </div>
          <Code className="select-all">{revealed ? secret : "•".repeat(secret.length)}</Code>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => copy(created.install?.claudeCodeCommand ?? "", "Commande Claude Code")}>
              Copier la commande Claude Code
            </Button>
            <Button size="sm" variant="secondary" onClick={() => copy(created.install?.json ?? "", "JSON")}>
              Copier le .mcp.json
            </Button>
            <Button size="sm" variant="secondary" onClick={() => copy(created.install?.codexConfig ?? "", "Config Codex")}>
              Copier le TOML Codex
            </Button>
            <Button size="sm" onClick={downloadInstall} disabled={!created.install?.markdown}>
              Télécharger INSTALL-{created.key?.name ?? "key"}.md
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Configuration client" subtitle={created.install?.url ?? "/mcp"} />
        <CardBody className="flex flex-col gap-3">
          <div>
            <span className="label">Claude Code</span>
            <Code>{created.install?.claudeCodeCommand ?? ""}</Code>
          </div>
          <div>
            <span className="label">Codex (~/.codex/config.toml)</span>
            <Code>{created.install?.codexConfig ?? ""}</Code>
          </div>
          <div>
            <span className="label">.mcp.json générique</span>
            <Code>{created.install?.json ?? ""}</Code>
          </div>
          {created.install?.allowed && created.install.allowed.length > 0 ? (
            <div>
              <span className="label">Droits effectifs</span>
              <div className="flex flex-col gap-1">
                {created.install.allowed.map((up) => (
                  <div key={up.slug} className="text-[12px]">
                    <Mono className="text-ink">{up.slug}</Mono>{" "}
                    <span className="text-muted">
                      — {up.name} : {up.tools.length} outil(s)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <Callout tone="info" title="Aucun droit pour l'instant">
              Cette clé ne voit aucun outil. Modifiez ses droits depuis sa fiche pour que l&apos;agent voie quelque chose.
            </Callout>
          )}
        </CardBody>
      </Card>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onDone}>
          Terminer
        </Button>
        {created.key ? (
          <a href={"/keys/" + created.key.id} className="btn btn-primary">
            Ouvrir la fiche de la clé
          </a>
        ) : null}
      </div>
    </div>
  );
}
