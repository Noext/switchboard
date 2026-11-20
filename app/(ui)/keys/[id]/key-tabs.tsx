"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, Input, Select } from "@/components/ui/input";
import { Callout, Code, Spinner } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorMessage } from "@/components/client-api";
import { absTime, relTime } from "@/components/format";
import type { EditorUpstream, GrantState } from "@/components/access/access-editor";
import { AccessEditor } from "@/components/access/access-editor";

/** Key header actions: revoke, rotate (with grace), duplicate, edit roles/expiration. */
export function KeyActions({
  keyId,
  name,
  revoked,
  roleIds,
  roles,
  exposureMode,
}: {
  keyId: string;
  name: string;
  revoked: boolean;
  roleIds: string[];
  roles: Array<{ id: string; name: string }>;
  exposureMode: "direct" | "discovery";
}) {
  const router = useRouter();
  const toast = useToast();
  const [dialog, setDialog] = React.useState<null | "revoke" | "rotate" | "duplicate" | "edit">(null);
  const [busy, setBusy] = React.useState(false);
  const [grace, setGrace] = React.useState("0");
  const [dupName, setDupName] = React.useState(name + "-copie");
  const [newName, setNewName] = React.useState(name);
  const [newRoles, setNewRoles] = React.useState<string[]>(roleIds);
  const [newExposure, setNewExposure] = React.useState(exposureMode);
  const [newExpiry, setNewExpiry] = React.useState("");
  const [newSecret, setNewSecret] = React.useState<string | null>(null);

  async function doRevoke() {
    setBusy(true);
    try {
      await apiRequest("/api/v1/keys/" + keyId + "/revoke", { method: "POST", body: {} });
      toast.push("Clé révoquée. Les sessions ouvertes sont fermées.", "ok");
      setDialog(null);
      router.refresh();
    } catch (err) {
      toast.push(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function doRotate() {
    setBusy(true);
    try {
      const res = await apiRequest<{ secret: string }>("/api/v1/keys/" + keyId + "/rotate", {
        method: "POST",
        body: { graceSeconds: Number(grace) || 0 },
      });
      setNewSecret(res.secret);
      toast.push("Nouveau secret généré.", "ok");
    } catch (err) {
      toast.push(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function doDuplicate() {
    setBusy(true);
    try {
      const res = await apiRequest<{ secret: string; key?: { id: string } }>("/api/v1/keys/" + keyId + "/duplicate", {
        method: "POST",
        body: { name: dupName.trim() },
      });
      toast.push("Clé dupliquée. Nouveau secret : " + res.secret, "ok");
      setDialog(null);
      router.refresh();
    } catch (err) {
      toast.push(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function doEdit() {
    setBusy(true);
    try {
      const body: Record<string, unknown> = { name: newName.trim(), roleIds: newRoles, exposureMode: newExposure };
      if (newExpiry) body.expiresAt = new Date(newExpiry + "T23:59:59").getTime();
      await apiRequest("/api/v1/keys/" + keyId, { method: "PATCH", body });
      toast.push("Clé mise à jour.", "ok");
      setDialog(null);
      router.refresh();
    } catch (err) {
      toast.push(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button size="sm" onClick={() => setDialog("edit")}>
        Éditer
      </Button>
      <a href={"/api/v1/keys/" + keyId + "/install.md"} className="btn btn-secondary btn-sm" target="_blank" rel="noreferrer">
        INSTALL.md
      </a>
      <a href={"/api/v1/keys/" + keyId + "/install.md?download=1"} className="btn btn-ghost btn-sm" download>
        Télécharger
      </a>
      {!revoked ? (
        <>
          <Button size="sm" onClick={() => setDialog("rotate")}>
            Régénérer
          </Button>
          <Button size="sm" onClick={() => setDialog("duplicate")}>
            Dupliquer
          </Button>
          <Button size="sm" variant="ghost" className="text-bad" onClick={() => setDialog("revoke")}>
            Révoquer
          </Button>
        </>
      ) : null}

      {dialog === "revoke" ? (
        <Overlay onClose={() => setDialog(null)} title={"Révoquer « " + name + " » ?"}>
          <p className="text-[12px] text-muted">
            Effet immédiat : toutes les sessions MCP ouvertes de cette clé sont fermées et les appels renvoient 401. Les droits sont conservés mais
            la clé ne peut plus être réactivée.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Annuler
            </Button>
            <Button variant="danger" onClick={doRevoke} disabled={busy}>
              {busy ? "Révocation…" : "Révoquer"}
            </Button>
          </div>
        </Overlay>
      ) : null}

      {dialog === "rotate" ? (
        <Overlay onClose={() => setDialog(null)} title="Régénérer le secret">
          {newSecret ? (
            <div className="flex flex-col gap-2">
              <Callout tone="warn" title="Nouveau secret — affiché une seule fois">
                Copiez-le maintenant et mettez à jour la configuration de l&apos;agent.
              </Callout>
              <Code className="select-all">{newSecret}</Code>
              <div className="flex justify-end">
                <Button
                  onClick={() => {
                    setDialog(null);
                    setNewSecret(null);
                    router.refresh();
                  }}
                >
                  Fermer
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <p className="text-[12px] text-muted">
                Le nouveau secret remplace l&apos;ancien immédiatement, sauf délai de grâce. Les droits et rôles sont conservés.
              </p>
              <Field label="Délai de grâce pour l'ancien secret">
                <Select
                  value={grace}
                  onChange={(e) => setGrace(e.target.value)}
                  options={[
                    { value: "0", label: "Aucun — l'ancien secret meurt tout de suite" },
                    { value: "3600", label: "1 heure" },
                    { value: "86400", label: "24 heures" },
                  ]}
                />
              </Field>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setDialog(null)}>
                  Annuler
                </Button>
                <Button variant="primary" onClick={doRotate} disabled={busy}>
                  {busy ? "Génération…" : "Générer"}
                </Button>
              </div>
            </div>
          )}
        </Overlay>
      ) : null}

      {dialog === "duplicate" ? (
        <Overlay onClose={() => setDialog(null)} title="Dupliquer la clé">
          <div className="flex flex-col gap-3">
            <p className="text-[12px] text-muted">
              Une nouvelle clé avec les mêmes rôles, droits propres et retraits. Le secret de la nouvelle clé n&apos;est visible qu&apos;une fois.
            </p>
            <Field label="Nom de la nouvelle clé">
              <Input value={dupName} onChange={(e) => setDupName(e.target.value)} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDialog(null)}>
                Annuler
              </Button>
              <Button variant="primary" onClick={doDuplicate} disabled={busy || !dupName.trim()}>
                {busy ? "Duplication…" : "Dupliquer"}
              </Button>
            </div>
          </div>
        </Overlay>
      ) : null}

      {dialog === "edit" ? (
        <Overlay onClose={() => setDialog(null)} title={"Éditer « " + name + " »"}>
          <div className="flex flex-col gap-3">
            <Field label="Nom">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} />
            </Field>
            <Field label="Mode d'exposition">
              <Select
                value={newExposure}
                onChange={(e) => setNewExposure(e.target.value as "direct" | "discovery")}
                options={[
                  { value: "direct", label: "direct" },
                  { value: "discovery", label: "discovery" },
                ]}
              />
            </Field>
            <Field label="Expiration (optionnel)">
              <Input type="date" value={newExpiry} onChange={(e) => setNewExpiry(e.target.value)} />
            </Field>
            <Field label="Rôles">
              <div className="flex flex-wrap gap-1.5">
                {roles.map((r) => {
                  const on = newRoles.includes(r.id);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setNewRoles((prev) => (on ? prev.filter((x) => x !== r.id) : [...prev, r.id]))}
                      className={
                        "rounded-full border px-2 py-0.5 text-[11.5px] " +
                        (on ? "border-accent bg-[hsl(var(--panel-3))] text-ink" : "border-line text-muted hover:text-ink")
                      }
                    >
                      {on ? "✓ " : ""}
                      {r.name}
                    </button>
                  );
                })}
              </div>
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDialog(null)}>
                Annuler
              </Button>
              <Button variant="primary" onClick={doEdit} disabled={busy}>
                {busy ? "Enregistrement…" : "Enregistrer"}
              </Button>
            </div>
          </div>
        </Overlay>
      ) : null}
    </div>
  );
}

function Overlay({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-[520px] p-4" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="mb-2 text-[14px] font-semibold">{title}</div>
        {children}
      </div>
    </div>
  );
}

/** Rights tab: the shared accordion editor, scoped to a key with origin badges + denies. */
export function RightsTab({
  keyId,
  upstreams,
  grants,
  origins,
}: {
  keyId: string;
  upstreams: EditorUpstream[];
  grants: GrantState[];
  origins: { origins: Record<string, Record<string, { own: boolean; roles: string[] }>>; denies: Array<{ upstreamId: string; toolName: string | null }> };
}) {
  return <AccessEditor subjectType="key" subjectId={keyId} upstreams={upstreams} grants={grants} origins={origins} />;
}

interface SessionInfo {
  sessionId?: string;
  id?: string;
  clientName?: string | null;
  clientVersion?: string | null;
  clientInfo?: { name?: string; version?: string } | null;
  ip?: string | null;
  since?: number | null;
  connectedAt?: number | null;
  lastActivity?: number | null;
  keyId?: string;
}

/** Open MCP sessions for a key, polled from /api/v1/status. */
export function SessionsPanel({ keyId }: { keyId: string }) {
  const [sessions, setSessions] = React.useState<SessionInfo[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiRequest<{ sessions?: SessionInfo[]; openSessions?: SessionInfo[] }>("/api/v1/status");
        if (cancelled) return;
        const all = res.openSessions ?? res.sessions ?? [];
        setSessions(all.filter((s) => !s.keyId || s.keyId === keyId));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
    };
    void load();
    const timer = setInterval(load, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [keyId]);

  if (error) {
    return <Callout tone="warn" title="Registre de sessions indisponible">{error}</Callout>;
  }
  if (sessions === null) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <Spinner /> chargement…
      </div>
    );
  }
  if (sessions.length === 0) {
    return (
      <p className="text-[12px] text-muted">
        Aucune session MCP ouverte pour cette clé. Une session apparaît dès qu&apos;un client fait un <span className="mono">initialize</span> sur
        /mcp avec cette clé.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      {sessions.map((s, i) => (
        <div key={s.sessionId ?? s.id ?? i} className="surface flex flex-wrap items-center gap-2 px-2.5 py-1.5 text-[12px]">
          <Badge tone="ok">ouverte</Badge>
          <span className="mono text-[11px]">{s.sessionId ?? s.id ?? "—"}</span>
          <span className="text-muted">
            {s.clientInfo?.name ?? s.clientName ?? "client inconnu"}
            {s.clientInfo?.version ?? s.clientVersion ? " v" + (s.clientInfo?.version ?? s.clientVersion) : ""}
          </span>
          {s.ip ? <span className="mono text-[11px] text-muted">{s.ip}</span> : null}
          <span className="ml-auto text-[11px] text-muted">
            {s.since ?? s.connectedAt ? "depuis " + relTime(s.since ?? s.connectedAt ?? null) : ""}
            {s.lastActivity ? " · activité " + relTime(s.lastActivity) : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Install tab: INSTALL markdown + snippets fetched from the export endpoint. */
export function InstallPanel({ keyId, keyName }: { keyId: string; keyName: string }) {
  const [data, setData] = React.useState<{
    mcpUrl?: string;
    snippets?: { claudeCodeCommand: string; codexToml: string; mcpJson: string };
    markdown?: string;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [markdown, setMarkdown] = React.useState<string | null>(null);
  const toast = useToast();

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await apiRequest<{
          mcpUrl?: string;
          snippets?: { claudeCodeCommand: string; codexToml: string; mcpJson: string };
        }>("/api/v1/export?key=" + keyId);
        if (!cancelled) setData(res);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      }
      try {
        const res = await fetch("/api/v1/keys/" + keyId + "/install.md", { credentials: "same-origin" });
        if (!cancelled && res.ok) setMarkdown(await res.text());
      } catch {
        /* keep snippets only */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [keyId]);

  function download() {
    if (!markdown) return;
    // Server already sets Content-Disposition: attachment with ?download=1.
    window.location.href = "/api/v1/keys/" + keyId + "/install.md?download=1";
  }

  if (error) return <Callout tone="bad" title="Impossible de charger les snippets">{error}</Callout>;
  if (!data) {
    return (
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <Spinner /> chargement…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader
          title="Snippets de configuration"
          subtitle={data.mcpUrl ?? "/mcp"}
          actions={
            <>
              <Button size="xs" onClick={() => navigator.clipboard.writeText(data.snippets?.claudeCodeCommand ?? "").then(() => toast.push("Copié.", "ok"))}>
                Copier Claude Code
              </Button>
              <Button size="xs" variant="ghost" onClick={download} disabled={!markdown}>
                Télécharger INSTALL-{keyName}.md
              </Button>
            </>
          }
        />
        <CardBody className="flex flex-col gap-3">
          <div>
            <span className="label">Claude Code</span>
            <Code>{data.snippets?.claudeCodeCommand ?? ""}</Code>
          </div>
          <div>
            <span className="label">Codex (~/.codex/config.toml)</span>
            <Code>{data.snippets?.codexToml ?? ""}</Code>
          </div>
          <div>
            <span className="label">.mcp.json</span>
            <Code>{data.snippets?.mcpJson ?? ""}</Code>
          </div>
          <p className="text-[11px] text-muted">
            Les snippets contiennent un emplacement de secret (<span className="mono">sk-sw-xxxxxxxx</span>) : le vrai secret n&apos;est plus
            récupérable après la création. Utilisez la rotation pour en générer un nouveau.
          </p>
        </CardBody>
      </Card>

      {markdown ? (
        <Card>
          <CardHeader title={"INSTALL-" + keyName + ".md"} subtitle="Document prêt à donner à l'agent : URL, clé, commandes, droits exacts." />
          <CardBody className="p-0">
            <pre className="scroll-thin max-h-[520px] overflow-auto bg-[hsl(var(--bg))] p-3 mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
              {markdown}
            </pre>
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
