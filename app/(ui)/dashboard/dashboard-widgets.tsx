"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/input";
import { Modal } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorMessage } from "@/components/client-api";
import { relTime } from "@/components/format";

interface Subject {
  subjectType: "key" | "role";
  subjectId: string;
  label: string;
  selected: boolean;
}

/** "accorder à…" quick action for a newly detected tool (spec §7.4 / dashboard). */
export function GrantDiscoveryActions({
  upstreamId,
  toolName,
  upstreamSlug,
}: {
  upstreamId: string;
  toolName: string;
  upstreamSlug: string | null;
}) {
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [subjects, setSubjects] = React.useState<Subject[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await apiRequest<{ items?: Array<{ id: string; name: string }> }>("/api/v1/keys");
        const rolesRes = await apiRequest<{ items?: Array<{ id: string; name: string }> }>("/api/v1/roles");
        if (cancelled) return;
        setSubjects([
          ...(res.items ?? []).map((k) => ({
            subjectType: "key" as const,
            subjectId: k.id,
            label: k.name,
            selected: false,
          })),
          ...(rolesRes.items ?? []).map((r) => ({
            subjectType: "role" as const,
            subjectId: r.id,
            label: r.name,
            selected: false,
          })),
        ]);
      } catch {
        if (!cancelled) setSubjects([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function grant() {
    const selected = subjects.filter((s) => s.selected);
    if (selected.length === 0) {
      toast.push("Sélectionnez au moins un sujet.", "warn");
      return;
    }
    setBusy(true);
    try {
      await apiRequest("/api/v1/discoveries/grant", {
        method: "POST",
        body: {
          upstreamId,
          toolName,
          subjects: selected.map((s) => ({ subjectType: s.subjectType, subjectId: s.subjectId })),
        },
      });
      toast.push("Accès accordé à " + selected.length + " sujet(s).", "ok");
      setOpen(false);
      window.location.reload();
    } catch (err) {
      toast.push(errorMessage(err), "bad");
    } finally {
      setBusy(false);
    }
  }

  async function ignore() {
    try {
      await apiRequest("/api/v1/discoveries/ack", {
        method: "POST",
        body: { items: [{ upstreamId, toolName }] },
      });
      toast.push("Outil ignoré.", "info");
      window.location.reload();
    } catch (err) {
      toast.push(errorMessage(err), "bad");
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      <span className="mono text-[11px] text-muted">{upstreamSlug ? upstreamSlug + "__" : ""}</span>
      <Button size="xs" onClick={() => setOpen(true)}>
        Accorder à…
      </Button>
      <Button size="xs" variant="ghost" onClick={ignore}>
        Ignorer
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={"Accorder " + (upstreamSlug ?? "") + "__" + toolName}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Annuler
            </Button>
            <Button variant="primary" onClick={grant} disabled={busy}>
              {busy ? "Application…" : "Accorder"}
            </Button>
          </>
        }
      >
        <p className="mb-2 text-[12px] text-muted">
          Les sujets en mode « tous les outils » ont déjà reçu ce nouvel outil. Ceux en mode sélection doivent être cochés ici.
        </p>
        {loading ? (
          <div className="flex items-center gap-2 text-[12px] text-muted">
            <Spinner /> chargement…
          </div>
        ) : subjects.length === 0 ? (
          <p className="text-[12px] text-muted">Aucune clé ni rôle à qui accorder cet outil.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {subjects.map((s) => (
              <Checkbox
                key={s.subjectType + s.subjectId}
                checked={s.selected}
                onChange={(next) =>
                  setSubjects((prev) =>
                    prev.map((x) => (x.subjectType === s.subjectType && x.subjectId === s.subjectId ? { ...x, selected: next } : x)),
                  )
                }
                label={
                  <span className="flex items-center gap-1.5">
                    <Badge tone={s.subjectType === "role" ? "violet" : "accent"}>{s.subjectType === "role" ? "rôle" : "clé"}</Badge>
                    {s.label}
                  </span>
                }
              />
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}

/** Live open sessions count, refreshed from the status endpoint (spec §7.1 "sessions ouvertes"). */
export function LiveSessions() {
  const [count, setCount] = React.useState<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiRequest<{ sessions?: unknown[]; openSessions?: unknown[] }>("/api/v1/status");
        if (cancelled) return;
        const list = res.openSessions ?? res.sessions ?? [];
        setCount(Array.isArray(list) ? list.length : 0);
      } catch {
        if (!cancelled) setCount(null);
      }
    };
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="flex items-center justify-between rounded-md border border-line bg-[hsl(var(--bg))] px-2.5 py-1.5">
      <span className="text-[11.5px] text-muted">Sessions MCP ouvertes</span>
      <span className="text-[13px] font-semibold tabular-nums">{count === null ? "—" : count}</span>
    </div>
  );
}

/** Starts the OAuth browser flow for one upstream and follows the returned URL. */
export function OAuthReconnectButton({ upstreamId }: { upstreamId: string }) {
  const [busy, setBusy] = React.useState(false);
  const toast = useToast();

  return (
    <Button
      size="sm"
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
          if (target) window.location.href = target;
          else toast.push("Aucune URL d'autorisation renvoyée.", "warn");
        } catch (err) {
          toast.push(errorMessage(err), "bad");
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Redirection…" : "Se connecter"}
    </Button>
  );
}
