"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { Callout, Code, Mono, Spinner } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorMessage } from "@/components/client-api";
import { duration, relTime } from "@/components/format";
import type { EditorUpstream } from "@/components/access/access-editor";
import { AccessEditor } from "@/components/access/access-editor";

/** Restart / test / delete / reconnect actions in the server header. */
export function ServerActions({
  upstreamId,
  enabled,
  authType,
  name,
  oauthStatus,
}: {
  upstreamId: string;
  enabled: boolean;
  authType: string;
  name: string;
  oauthStatus: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  async function call(label: string, path: string, method: string, body?: unknown) {
    setBusy(label);
    try {
      await apiRequest(path, { method, body });
      toast.push(label + " : OK", "ok");
      router.refresh();
    } catch (err) {
      toast.push(label + " : " + errorMessage(err), "bad");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <a href={"/servers/" + upstreamId + "/edit"} className="btn btn-secondary btn-sm">
        Éditer
      </a>
      <Button size="sm" onClick={() => call("Test", "/api/v1/upstreams/test", "POST", { id: upstreamId })} disabled={busy !== null}>
        {busy === "Test" ? "Test…" : "Tester"}
      </Button>
      <Button size="sm" onClick={() => call("Redémarrage", "/api/v1/upstreams/" + upstreamId + "/restart", "POST", {})} disabled={busy !== null}>
        {busy === "Redémarrage" ? "…" : "Redémarrer"}
      </Button>
      <Button size="sm" onClick={() => call(enabled ? "Désactivation" : "Activation", "/api/v1/upstreams/" + upstreamId, "PATCH", { enabled: !enabled })} disabled={busy !== null}>
        {enabled ? "Désactiver" : "Activer"}
      </Button>
      {authType === "oauth" ? (
        <Button
          size="sm"
          variant={oauthStatus === "auth_required" ? "primary" : "secondary"}
          onClick={async () => {
            setBusy("OAuth");
            try {
              const res = await apiRequest<{ authorizationUrl?: string; url?: string }>(
                "/api/v1/upstreams/" + upstreamId + "/oauth/start",
                { method: "POST", body: {} },
              );
              const target = res.authorizationUrl ?? res.url;
              if (target) window.location.href = target;
              else toast.push("Aucune URL renvoyée par le serveur OAuth.", "warn");
            } catch (err) {
              toast.push(errorMessage(err), "bad");
            } finally {
              setBusy(null);
            }
          }}
          disabled={busy !== null}
        >
          Se connecter
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" className="text-bad" onClick={() => setConfirmOpen(true)}>
        Supprimer
      </Button>
      {confirmOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setConfirmOpen(false)}>
          <div className="card w-full max-w-[440px] p-4" onClick={(e) => e.stopPropagation()}>
            <div className="text-[14px] font-semibold">Supprimer « {name} » ?</div>
            <p className="mt-1.5 text-[12px] text-muted">
              Le serveur est retiré du catalogue, ses droits sont supprimés et toutes les sessions ouvertes sont notifiées. Cette action est
              irréversible.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
                Annuler
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  setConfirmOpen(false);
                  setBusy("Suppression");
                  try {
                    await apiRequest("/api/v1/upstreams/" + upstreamId, { method: "DELETE" });
                    toast.push("Serveur supprimé.", "ok");
                    router.push("/servers");
                    router.refresh();
                  } catch (err) {
                    toast.push(errorMessage(err), "bad");
                    setBusy(null);
                  }
                }}
              >
                Supprimer définitivement
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface CallLogItem {
  id: string;
  at: number;
  name: string;
  ok: boolean;
  denied: boolean;
  durationMs: number | null;
  argsPreview?: string | null;
  resultPreview?: string | null;
  errorCode?: string | null;
}

/** Test console (spec §8 "console de test") : pick a tool, edit JSON args, see the result. */
export function TestConsole({
  upstreamId,
  tools,
  preselectedTool,
}: {
  upstreamId: string;
  tools: Array<{ name: string; publicName: string }>;
  preselectedTool: string | null;
}) {
  const toast = useToast();
  const first = preselectedTool && tools.some((t) => t.name === preselectedTool) ? preselectedTool : (tools[0]?.name ?? "");
  const [tool, setTool] = React.useState(first);
  const [args, setArgs] = React.useState("{\n  \n}");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<CallLogItem | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function run() {
    if (!tool) {
      toast.push("Sélectionnez un outil.", "warn");
      return;
    }
    let parsed: unknown;
    try {
      parsed = args.trim() ? JSON.parse(args) : {};
    } catch {
      setError("Arguments JSON invalides.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiRequest<{ call?: CallLogItem }>("/api/v1/upstreams/" + upstreamId + "/test", {
        method: "POST",
        body: { tool, args: parsed },
      });
      setResult(res.call ?? null);
      toast.push("Appel effectué.", res.call?.ok === false ? "warn" : "ok");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {tools.length === 0 ? (
        <Callout tone="info" title="Aucun outil disponible">
          Le serveur n&apos;a publié aucun outil, ou il n&apos;est pas connecté. Lancez un test de connexion depuis l&apos;en-tête.
        </Callout>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,320px)_1fr]">
        <div className="flex flex-col gap-2">
          <Field label="Outil">
            <Select
              value={tool}
              onChange={(e) => setTool(e.target.value)}
              options={tools.map((t) => ({ value: t.name, label: t.publicName }))}
            />
          </Field>
          <Field label="Arguments (JSON)">
            <textarea
              className="textarea mono min-h-[180px]"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              spellCheck={false}
            />
          </Field>
          <Button variant="primary" onClick={run} disabled={busy || !tool}>
            {busy ? <Spinner /> : null}
            {busy ? "Appel en cours…" : "Appeler l'outil"}
          </Button>
        </div>
        <div className="min-w-0">
          <span className="label">Résultat</span>
          {error ? <Callout tone="bad">{error}</Callout> : null}
          {result ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                {result.ok ? <Badge tone="ok">succès</Badge> : <Badge tone="bad">erreur</Badge>}
                {result.durationMs !== null ? <span className="text-muted">{duration(result.durationMs)}</span> : null}
                {result.errorCode ? <Badge tone="warn">{result.errorCode}</Badge> : null}
              </div>
              <Code className="max-h-[320px]">{result.resultPreview ?? "(vide)"}</Code>
            </div>
          ) : (
            <div className="rounded-md border border-line bg-[hsl(var(--bg))] px-3 py-8 text-center text-[12px] text-muted">
              Le résultat de l&apos;appel s&apos;affiche ici. Chaque essai est journalisé dans l&apos;onglet Journal.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** stderr ring buffer, polled every 3 s while the tab is open. */
export function StderrPanel({ upstreamId, initialLines, disabled }: { upstreamId: string; initialLines: string[]; disabled: boolean }) {
  const [lines, setLines] = React.useState(initialLines);
  const [autoScroll, setAutoScroll] = React.useState(true);
  const ref = React.useRef<HTMLPreElement | null>(null);

  React.useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiRequest<{ lines?: string[]; stderr?: string[] }>("/api/v1/upstreams/" + upstreamId + "/stderr");
        if (!cancelled) setLines(res.lines ?? res.stderr ?? []);
      } catch {
        /* keep the last known lines */
      }
    };
    const timer = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [upstreamId, disabled]);

  React.useEffect(() => {
    if (autoScroll && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines, autoScroll]);

  if (disabled) {
    return <p className="px-3 py-6 text-center text-[12px] text-muted">Ce serveur n&apos;est pas en stdio : pas de flux stderr.</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
        <span className="text-[11px] text-muted">{lines.length} ligne(s) — rafraîchi toutes les 3 s</span>
        <Checkbox checked={autoScroll} onChange={setAutoScroll} label="Défilement auto" />
      </div>
      <pre ref={ref} className="scroll-thin max-h-[480px] overflow-auto bg-[hsl(var(--bg))] p-2.5 mono text-[11px] leading-relaxed">
        {lines.length === 0 ? "(vide)" : lines.join("\n")}
      </pre>
    </div>
  );
}

/** OAuth tab: explains the flow, shows status and starts the browser round-trip. */
export function OAuthPanel({
  upstreamId,
  authType,
  status,
  lastError,
}: {
  upstreamId: string;
  authType: string;
  status: string;
  lastError: string | null;
}) {
  const [busy, setBusy] = React.useState(false);
  const toast = useToast();
  const [url, setUrl] = React.useState<string | null>(null);

  if (authType !== "oauth") {
    return (
      <Callout tone="info" title="Ce serveur n'utilise pas OAuth">
        Son authentification est « {authType} ». Modifiez-la dans la fiche d&apos;édition si le serveur amont exige OAuth 2.1.
      </Callout>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <dl className="kv">
        <dt>Statut</dt>
        <dd>
          <StatusBadge status={status} />
        </dd>
        <dt>Callback</dt>
        <dd className="mono text-[11.5px]">/oauth/callback</dd>
        {lastError ? (
          <>
            <dt>Dernière erreur</dt>
            <dd className="text-bad">{lastError}</dd>
          </>
        ) : null}
      </dl>
      <p className="text-[12px] text-muted">
        Le flux suit OAuth 2.1 + PKCE (S256) : découverte de la ressource protégée (RFC 9728), du serveur d&apos;autorisation (RFC 8414),
        enregistrement dynamique du client (RFC 7591) si nécessaire, puis redirection navigateur. Les tokens sont chiffrés au repos et
        rafraîchis automatiquement.
      </p>
      <div>
        <Button
          variant="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await apiRequest<{ authorizationUrl?: string; url?: string }>(
                "/api/v1/upstreams/" + upstreamId + "/oauth/start",
                { method: "POST", body: {} },
              );
              const target = res.authorizationUrl ?? res.url;
              if (target) {
                setUrl(target);
                window.location.href = target;
              } else toast.push("Aucune URL d'autorisation renvoyée.", "warn");
            } catch (err) {
              toast.push(errorMessage(err), "bad");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Préparation…" : status === "auth_required" ? "Se reconnecter" : "Se connecter"}
        </Button>
      </div>
      {url ? (
        <div>
          <span className="label">URL d&apos;autorisation</span>
          <Code>{url}</Code>
        </div>
      ) : null}
    </div>
  );
}

/**
 * "Modifier les droits" for this MCP: pick a key or a role, then reuse the shared access editor
 * scoped to this single upstream.
 */
export function AccessSection({
  upstream,
  keyChoices,
  roleChoices,
  grants,
}: {
  upstreamId: string;
  upstream: EditorUpstream;
  keyChoices: Array<{ id: string; name: string }>;
  roleChoices: Array<{ id: string; name: string }>;
  grants: Array<{ subjectType: "key" | "role"; subjectId: string; toolMode: "all" | "selected"; tools: string[] }>;
}) {
  const [kind, setKind] = React.useState<"key" | "role">("key");
  const [subjectId, setSubjectId] = React.useState("");
  const options = kind === "key" ? keyChoices : roleChoices;
  const effectiveSubjectId = subjectId || (options[0]?.id ?? "");
  const subjectGrants = grants
    .filter((g) => g.subjectType === kind && g.subjectId === effectiveSubjectId)
    .map((g) => ({
      upstreamId: upstream.id,
      mode: g.toolMode,
      tools: g.tools,
      prompts: false,
      resources: false,
    }));

  if (keyChoices.length === 0 && roleChoices.length === 0) {
    return <p className="text-[12px] text-muted">Aucune clé ni rôle existant.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Type de sujet" className="w-[140px]">
          <Select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as "key" | "role");
              setSubjectId("");
            }}
            options={[
              { value: "key", label: "Clé API" },
              { value: "role", label: "Rôle" },
            ]}
          />
        </Field>
        <Field label={kind === "key" ? "Clé" : "Rôle"} className="w-[260px]">
          <Select
            value={effectiveSubjectId}
            onChange={(e) => setSubjectId(e.target.value)}
            options={options.map((o) => ({ value: o.id, label: o.name }))}
          />
        </Field>
      </div>
      {effectiveSubjectId ? (
        <AccessEditor
          subjectType={kind}
          subjectId={effectiveSubjectId}
          upstreams={[upstream]}
          grants={subjectGrants}
          compact
        />
      ) : null}
    </div>
  );
}
