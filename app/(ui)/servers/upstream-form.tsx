"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Callout, Code, Spinner } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorMessage } from "@/components/client-api";

interface EditorUpstream {
  id: string;
  slug: string;
  name: string;
  tools: Array<{ name: string; description: string | null }>;
}

interface SubjectChoice {
  id: string;
  name: string;
}

export interface UpstreamFormValues {
  name: string;
  slug: string;
  description: string;
  transport: "http" | "sse" | "stdio";
  url: string;
  command: string;
  args: string;
  cwd: string;
  authType: "none" | "headers" | "bearer" | "oauth";
  bearerToken: string;
  headers: Array<{ key: string; value: string }>;
  env: Array<{ key: string; value: string }>;
  enabled: boolean;
  startMode: "always" | "lazy";
  idleStopMinutes: number;
  callTimeoutSeconds: number;
}

const EMPTY: UpstreamFormValues = {
  name: "",
  slug: "",
  description: "",
  transport: "http",
  url: "",
  command: "",
  args: "",
  cwd: "",
  authType: "none",
  bearerToken: "",
  headers: [],
  env: [],
  enabled: true,
  startMode: "always",
  idleStopMinutes: 15,
  callTimeoutSeconds: 120,
};

function PairEditor({
  label,
  pairs,
  onChange,
  secret,
  hint,
}: {
  label: string;
  pairs: Array<{ key: string; value: string }>;
  onChange: (next: Array<{ key: string; value: string }>) => void;
  secret?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="flex flex-col gap-1">
        {pairs.map((pair, i) => (
          <div key={i} className="flex gap-1">
            <Input
              placeholder="NOM"
              value={pair.key}
              onChange={(e) => {
                const next = [...pairs];
                next[i] = { ...next[i], key: e.target.value };
                onChange(next);
              }}
              className="max-w-[210px] font-mono"
            />
            <Input
              placeholder="valeur"
              type={secret ? "password" : "text"}
              value={pair.value}
              onChange={(e) => {
                const next = [...pairs];
                next[i] = { ...next[i], value: e.target.value };
                onChange(next);
              }}
              className="font-mono"
            />
            <Button variant="ghost" size="xs" onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
              ✕
            </Button>
          </div>
        ))}
        <div>
          <Button variant="ghost" size="xs" onClick={() => onChange([...pairs, { key: "", value: "" }])}>
            + Ajouter
          </Button>
        </div>
      </div>
      {hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

interface TestResult {
  ok: boolean;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
  tools?: Array<{ name: string; description?: string }>;
  error?: string;
}

/**
 * Create / edit form for an upstream (spec §8 "Ajouter / éditer un serveur"):
 * transport-specific fields, "Tester la connexion", masked secrets and the access section.
 */
export function UpstreamForm({
  mode,
  upstreamId,
  initial,
  accessUpstreams,
  keyChoices,
  roleChoices,
  existingAccess,
}: {
  mode: "create" | "edit";
  upstreamId?: string;
  initial?: Partial<UpstreamFormValues>;
  accessUpstreams?: EditorUpstream[];
  keyChoices?: SubjectChoice[];
  roleChoices?: SubjectChoice[];
  existingAccess?: Array<{ subjectType: "key" | "role"; subjectId: string; toolMode: "all" | "selected"; tools: string[] }>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [values, setValues] = React.useState<UpstreamFormValues>({ ...EMPTY, ...initial });
  const [busy, setBusy] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [test, setTest] = React.useState<TestResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Access section (spec §7.4): roles and keys with mode all/selected.
  const [accessSubjects, setAccessSubjects] = React.useState<
    Record<string, { selected: boolean; toolMode: "all" | "selected"; tools: Set<string> }>
  >(() => {
    const draft: Record<string, { selected: boolean; toolMode: "all" | "selected"; tools: Set<string> }> = {};
    for (const a of existingAccess ?? []) {
      draft[a.subjectType + ":" + a.subjectId] = {
        selected: true,
        toolMode: a.toolMode,
        tools: new Set(a.tools),
      };
    }
    return draft;
  });
  const [allToolsForAccess, setAllToolsForAccess] = React.useState<Array<{ name: string; description: string | null }>>([]);
  const [accessPrompt, setAccessPrompt] = React.useState(false);
  const [accessResource, setAccessResource] = React.useState(false);

  const set = <K extends keyof UpstreamFormValues>(key: K, value: UpstreamFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  async function runTest() {
    setTesting(true);
    setTest(null);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        transport: values.transport,
        authType: values.authType,
      };
      if (values.transport === "stdio") {
        body.command = values.command.trim();
        body.args = values.args.trim() ? values.args.trim().split(/\s+/) : [];
        if (values.cwd.trim()) body.cwd = values.cwd.trim();
        const env: Record<string, string> = {};
        for (const pair of values.env) if (pair.key.trim()) env[pair.key.trim()] = pair.value;
        if (Object.keys(env).length) body.env = env;
      } else {
        body.url = values.url.trim();
        if (values.authType === "bearer" && values.bearerToken.trim()) body.bearerToken = values.bearerToken.trim();
        const headers: Record<string, string> = {};
        for (const pair of values.headers) if (pair.key.trim()) headers[pair.key.trim()] = pair.value;
        if (Object.keys(headers).length) body.headers = headers;
      }
      const res = await apiRequest<TestResult>("/api/v1/upstreams/test", { method: "POST", body });
      setTest(res);
      if (res.tools && res.tools.length) {
        setAllToolsForAccess(res.tools.map((t) => ({ name: t.name, description: t.description ?? null })));
      }
    } catch (err) {
      setTest({ ok: false, error: errorMessage(err) });
    } finally {
      setTesting(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: values.name.trim(),
        transport: values.transport,
        description: values.description.trim() || null,
        enabled: values.enabled,
        startMode: values.startMode,
        idleStopMinutes: Number(values.idleStopMinutes) || 15,
        callTimeoutSeconds: Number(values.callTimeoutSeconds) || 120,
        authType: values.authType,
      };
      if (values.slug.trim()) body.slug = values.slug.trim();
      if (values.transport === "stdio") {
        body.command = values.command.trim();
        body.args = values.args.trim() ? values.args.trim().split(/\s+/) : [];
        if (values.cwd.trim()) body.cwd = values.cwd.trim();
        if (values.env.length) {
          const env: Record<string, string> = {};
          for (const pair of values.env) if (pair.key.trim()) env[pair.key.trim()] = pair.value;
          if (Object.keys(env).length) body.env = env;
        }
      } else {
        body.url = values.url.trim();
        if (values.authType === "bearer" && values.bearerToken.trim()) body.bearerToken = values.bearerToken.trim();
        if (values.headers.length) {
          const headers: Record<string, string> = {};
          for (const pair of values.headers) if (pair.key.trim()) headers[pair.key.trim()] = pair.value;
          if (Object.keys(headers).length) body.headers = headers;
        }
      }

      if (mode === "create") {
        const subjects = Object.entries(accessSubjects)
          .filter(([, v]) => v.selected)
          .map(([key, v]) => {
            const [subjectType, ...rest] = key.split(":");
            return {
              subjectType,
              subjectId: rest.join(":"),
              toolMode: v.toolMode,
              tools: v.toolMode === "selected" ? Array.from(v.tools) : [],
              prompts: accessPrompt,
              resources: accessResource,
            };
          });
        if (subjects.length) {
          body.access = { subjects, prompts: accessPrompt, resources: accessResource };
        }
        const res = await apiRequest<{ upstream?: { id: string } }>("/api/v1/upstreams", { method: "POST", body });
        toast.push("Serveur créé.", "ok");
        const id = res.upstream?.id;
        router.push(id ? "/servers/" + id : "/servers");
      } else {
        await apiRequest("/api/v1/upstreams/" + upstreamId, { method: "PATCH", body });
        toast.push("Serveur mis à jour.", "ok");
        router.push("/servers/" + upstreamId);
      }
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      toast.push(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  }

  const isStdio = values.transport === "stdio";

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      {error ? <Callout tone="bad">{error}</Callout> : null}

      <Card>
        <CardHeader title="Identité" />
        <CardBody className="grid gap-3 sm:grid-cols-2">
          <Field label="Nom" htmlFor="name" hint="Libellé affiché dans l'interface.">
            <Input id="name" required value={values.name} onChange={(e) => set("name", e.target.value)} placeholder="GitHub" />
          </Field>
          <Field
            label="Slug (préfixe public)"
            htmlFor="slug"
            hint="1 à 12 caractères [a-z0-9]. Les outils deviennent <slug>__<outil>. Généré si vide."
          >
            <Input
              id="slug"
              value={values.slug}
              onChange={(e) => set("slug", e.target.value.replace(/[^a-z0-9]/g, "").slice(0, 12))}
              placeholder="gh"
              className="mono"
            />
          </Field>
          <Field label="Description" htmlFor="description" className="sm:col-span-2" hint="Visible par les agents dans les instructions du serveur MCP.">
            <Textarea
              id="description"
              rows={2}
              value={values.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Serveur MCP GitHub du compte bot…"
            />
          </Field>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Transport" />
        <CardBody className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={values.transport}
              onChange={(next) => set("transport", next as UpstreamFormValues["transport"])}
              options={[
                { value: "http", label: "Streamable HTTP" },
                { value: "sse", label: "SSE (ancien)" },
                { value: "stdio", label: "stdio (local)" },
              ]}
            />
            <span className="text-[11px] text-muted">
              {isStdio
                ? "Le process tourne dans le conteneur de la passerelle."
                : "Le MCP distant est joint directement ; repli SSE automatique si HTTP échoue."}
            </span>
          </div>

          {isStdio ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Commande" htmlFor="command" hint="Ex. npx, uvx, docker.">
                <Input id="command" required value={values.command} onChange={(e) => set("command", e.target.value)} placeholder="npx" className="font-mono" />
              </Field>
              <Field label="Arguments" htmlFor="args" hint="Séparés par des espaces.">
                <Input
                  id="args"
                  value={values.args}
                  onChange={(e) => set("args", e.target.value)}
                  placeholder="-y @modelcontextprotocol/server-github"
                  className="font-mono"
                />
              </Field>
              <Field label="Répertoire de travail" htmlFor="cwd" hint="Optionnel.">
                <Input id="cwd" value={values.cwd} onChange={(e) => set("cwd", e.target.value)} placeholder="/data/mcp" className="font-mono" />
              </Field>
              <Field
                label="Mode de démarrage"
                htmlFor="startMode"
                hint="lazy = démarre au premier appel puis s'arrête après inactivité."
              >
                <Select
                  id="startMode"
                  value={values.startMode}
                  onChange={(e) => set("startMode", e.target.value as "always" | "lazy")}
                  options={[
                    { value: "always", label: "always — démarré avec la passerelle" },
                    { value: "lazy", label: "lazy — au premier appel" },
                  ]}
                />
              </Field>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="URL" htmlFor="url" hint="URL du endpoint MCP (ex. https://mcp.exemple.fr/mcp)." className="sm:col-span-2">
                <Input id="url" required value={values.url} onChange={(e) => set("url", e.target.value)} placeholder="https://…/mcp" className="font-mono" />
              </Field>
              <Field label="Authentification" htmlFor="authType">
                <Select
                  id="authType"
                  value={values.authType}
                  onChange={(e) => set("authType", e.target.value as UpstreamFormValues["authType"])}
                  options={[
                    { value: "none", label: "Aucune" },
                    { value: "headers", label: "En-têtes personnalisés" },
                    { value: "bearer", label: "Bearer token" },
                    { value: "oauth", label: "OAuth 2.1 (bouton Se connecter)" },
                  ]}
                />
              </Field>
              {values.authType === "bearer" ? (
                <Field
                  label="Token bearer"
                  htmlFor="bearer"
                  hint={mode === "edit" ? "Laisser vide pour conserver le token actuel." : "Chiffré au repos, jamais réaffiché."}
                >
                  <Input
                    id="bearer"
                    type="password"
                    value={values.bearerToken}
                    onChange={(e) => set("bearerToken", e.target.value)}
                    placeholder="••••••••"
                  />
                </Field>
              ) : null}
            </div>
          )}

          {values.transport !== "stdio" && values.authType === "headers" ? (
            <PairEditor
              label="En-têtes HTTP"
              pairs={values.headers}
              onChange={(next) => set("headers", next)}
              secret
              hint="Chiffrés au repos et jamais réaffichés. En édition, ils ne sont pas pré-remplis : laisser vide pour conserver."
            />
          ) : null}

          {isStdio ? (
            <PairEditor
              label="Variables d'environnement"
              pairs={values.env}
              onChange={(next) => set("env", next)}
              secret
              hint="Seules ces variables (plus PATH et HOME) sont transmises au process."
            />
          ) : null}

          <div className="flex flex-wrap items-end gap-3 border-t border-line pt-2.5">
            <Field label="Timeout d'appel (s)" htmlFor="timeout" className="w-[150px]">
              <Input
                id="timeout"
                type="number"
                min={1}
                max={3600}
                value={values.callTimeoutSeconds}
                onChange={(e) => set("callTimeoutSeconds", Number(e.target.value))}
              />
            </Field>
            {isStdio ? (
              <Field label="Arrêt après inactivité (min)" htmlFor="idle" className="w-[210px]">
                <Input
                  id="idle"
                  type="number"
                  min={0}
                  max={10080}
                  value={values.idleStopMinutes}
                  onChange={(e) => set("idleStopMinutes", Number(e.target.value))}
                />
              </Field>
            ) : null}
            <Checkbox checked={values.enabled} onChange={(next) => set("enabled", next)} label="Serveur activé" />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Tester la connexion"
          subtitle="initialize + listing, sans rien enregistrer."
          actions={
            <Button variant="secondary" size="sm" onClick={runTest} disabled={testing}>
              {testing ? <Spinner /> : null}
              {testing ? "Test en cours…" : "Tester"}
            </Button>
          }
        />
        {test ? (
          <CardBody className="pt-2.5">
            {test.ok ? (
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <Badge tone="ok">connexion réussie</Badge>
                  {test.serverInfo?.name ? (
                    <span className="text-muted">
                      {test.serverInfo.name} {test.serverInfo.version ? "v" + test.serverInfo.version : ""}
                    </span>
                  ) : null}
                  <span className="text-muted">{(test.tools ?? []).length} outil(s) listé(s)</span>
                </div>
                {test.tools && test.tools.length > 0 ? (
                  <div className="scroll-thin max-h-[180px] overflow-y-auto rounded border border-line bg-[hsl(var(--bg))] p-2">
                    {test.tools.slice(0, 60).map((t) => (
                      <div key={t.name} className="truncate text-[11.5px]">
                        <span className="mono text-ink">{t.name}</span>
                        {t.description ? <span className="ml-1.5 text-muted">— {t.description}</span> : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <Callout tone="bad" title="Échec de la connexion">
                {test.error ?? "Erreur inconnue"}
              </Callout>
            )}
          </CardBody>
        ) : (
          <CardBody className="pt-2.5 text-[12px] text-muted">
            Renseignez le transport puis lancez un test : la passerelle fait un <span className="mono">initialize</span> et récupère le
            listing complet des outils, prompts et ressources.
          </CardBody>
        )}
      </Card>

      {mode === "create" ? (
        <Card>
          <CardHeader
            title="Accès (section §7.4)"
            subtitle="Qui peut utiliser ce MCP ? Rien de coché = personne (le serveur reste testable)."
          />
          <CardBody className="flex flex-col gap-3 pt-2.5">
            {keyChoices && keyChoices.length > 0 ? (
              <div>
                <span className="label">Clés</span>
                <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                  {keyChoices.map((k) => {
                    const key = "key:" + k.id;
                    const entry = accessSubjects[key] ?? { selected: false, toolMode: "all" as const, tools: new Set<string>() };
                    return (
                      <SubjectAccessRow
                        key={key}
                        label={k.name}
                        tone="accent"
                        entry={entry}
                        tools={allToolsForAccess}
                        onChange={(next) => setAccessSubjects((prev) => ({ ...prev, [key]: next }))}
                      />
                    );
                  })}
                </div>
              </div>
            ) : null}
            {roleChoices && roleChoices.length > 0 ? (
              <div>
                <span className="label">Rôles</span>
                <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                  {roleChoices.map((r) => {
                    const key = "role:" + r.id;
                    const entry = accessSubjects[key] ?? { selected: false, toolMode: "all" as const, tools: new Set<string>() };
                    return (
                      <SubjectAccessRow
                        key={key}
                        label={r.name}
                        tone="violet"
                        entry={entry}
                        tools={allToolsForAccess}
                        onChange={(next) => setAccessSubjects((prev) => ({ ...prev, [key]: next }))}
                      />
                    );
                  })}
                </div>
              </div>
            ) : null}
            {(!keyChoices || keyChoices.length === 0) && (!roleChoices || roleChoices.length === 0) ? (
              <p className="text-[12px] text-muted">Aucune clé ni rôle existant. Créez-les d&apos;abord depuis leurs pages dédiées.</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-4 border-t border-line pt-2">
              <Checkbox checked={accessPrompt} onChange={setAccessPrompt} label="Donner aussi les prompts" />
              <Checkbox checked={accessResource} onChange={setAccessResource} label="Donner aussi les ressources" />
            </div>
          </CardBody>
        </Card>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={() => router.push(mode === "create" ? "/servers" : "/servers/" + upstreamId)}>
          Annuler
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !values.name.trim()}>
          {busy ? "Enregistrement…" : mode === "create" ? "Créer le serveur" : "Enregistrer"}
        </Button>
      </div>
    </form>
  );
}

function SubjectAccessRow({
  label,
  tone,
  entry,
  tools,
  onChange,
}: {
  label: string;
  tone: "accent" | "violet";
  entry: { selected: boolean; toolMode: "all" | "selected"; tools: Set<string> };
  tools: Array<{ name: string; description: string | null }>;
  onChange: (next: { selected: boolean; toolMode: "all" | "selected"; tools: Set<string> }) => void;
}) {
  return (
    <div className="flex flex-col gap-1 rounded border border-line bg-[hsl(var(--bg))] px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <Checkbox
          checked={entry.selected}
          onChange={(next) => onChange({ ...entry, selected: next })}
          label={
            <span className="flex items-center gap-1.5">
              <Badge tone={tone}>{tone === "violet" ? "rôle" : "clé"}</Badge>
              {label}
            </span>
          }
        />
        {entry.selected ? (
          <Segmented
            value={entry.toolMode}
            onChange={(next) => onChange({ ...entry, toolMode: next as "all" | "selected" })}
            options={[
              { value: "all", label: "Tous" },
              { value: "selected", label: "Sélection" },
            ]}
          />
        ) : null}
      </div>
      {entry.selected && entry.toolMode === "selected" ? (
        tools.length === 0 ? (
          <span className="text-[10.5px] text-muted">Testez la connexion pour lister les outils.</span>
        ) : (
          <div className="scroll-thin max-h-[110px] overflow-y-auto">
            {tools.map((t) => (
              <Checkbox
                key={t.name}
                checked={entry.tools.has(t.name)}
                onChange={(next) => {
                  const set = new Set(entry.tools);
                  if (next) set.add(t.name);
                  else set.delete(t.name);
                  onChange({ ...entry, tools: set });
                }}
                label={<span className="mono text-[11px]">{t.name}</span>}
                className="block py-0.5"
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}