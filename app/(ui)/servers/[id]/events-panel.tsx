"use client";

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, EmptyState } from "@/components/ui/card";
import { Callout, Code, Mono, Spinner } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorMessage } from "@/components/client-api";

/**
 * MCP Events types served by one upstream.
 *
 * The gateway relays the Events extension (SEP-3415); this panel shows what an upstream actually
 * advertises, fetched through `GET /api/v1/upstreams/{id}/events` (which reuses the same raw
 * request path an agent would take, so the UI cannot drift from the wire).
 *
 * Three states matter and look different: supported with N types, supported by the protocol but
 * the server does not implement it, and a genuine failure (unreachable, auth).
 */

interface EventType {
  name: string;
  description?: string;
  delivery?: string[];
  inputSchema?: unknown;
  payloadSchema?: unknown;
}

interface EventsResponse {
  supported: boolean;
  reason?: string;
  error?: boolean;
  revision?: string;
  extension?: string;
  methods?: string[];
  events: EventType[];
  upstream: { slug: string; name: string };
}

function DeliveryBadges({ modes }: { modes: string[] | undefined }) {
  if (!modes || modes.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {modes.map((mode) => (
        <Badge key={mode} tone={mode === "webhook" ? "info" : "neutral"}>
          {mode}
        </Badge>
      ))}
    </span>
  );
}

function SchemaDetails({ label, schema }: { label: string; schema: unknown }) {
  if (schema === undefined || schema === null) return null;
  const text = JSON.stringify(schema, null, 2);
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-[11.5px] text-muted hover:text-ink">{label}</summary>
      <pre className="mono mt-1.5 max-h-56 overflow-auto rounded border border-line bg-panel-2 p-2 text-[11px] leading-relaxed">
        {text}
      </pre>
    </details>
  );
}

export function EventsPanel({ upstreamId, upstreamSlug }: { upstreamId: string; upstreamSlug: string }) {
  const toast = useToast();
  const [data, setData] = React.useState<EventsResponse | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [failure, setFailure] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await apiRequest<EventsResponse>("/api/v1/upstreams/" + encodeURIComponent(upstreamId) + "/events");
      setData(result);
    } catch (error) {
      setFailure(errorMessage(error));
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [upstreamId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function copyName(name: string) {
    try {
      await navigator.clipboard.writeText(name);
      toast.push("Nom copié : " + name, "ok");
    } catch {
      toast.push("Copie impossible dans ce navigateur.", "warn");
    }
  }

  // The panel is a client component: on the very first paint there is no data yet. Show the
  // loading state rather than rendering nothing, so the tab is never a blank page.
  if (!data && !failure) {
    return (
      <Card>
        <CardHeader title="Événements MCP" subtitle={"Extension MCP Events (SEP-3415) — " + upstreamSlug} />
        <CardBody>
          <span className="flex items-center gap-2 text-muted">
            <Spinner /> Interrogation de <Mono>{upstreamSlug}</Mono>…
          </span>
        </CardBody>
      </Card>
    );
  }

  if (failure) {
    return (
      <Card>
        <CardBody>
          <Callout tone="bad" title="Impossible de lire les types d'événements">
            <span className="mono text-[11.5px]">{failure}</span>
          </Callout>
          <div className="mt-2">
            <Button variant="ghost" onClick={() => void load()} disabled={busy}>
              Réessayer
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  if (!data) return null;

  if (!data.supported) {
    return (
      <Card>
        <CardHeader title="Événements MCP" subtitle={"Extension MCP Events (SEP-3415) — " + data.upstream.name} />
        <CardBody>
          <Callout tone={data.error ? "warn" : "info"} title="Ce serveur n'expose pas d'événements">
            {data.reason ?? "L'extension n'est pas servie par ce serveur."}
          </Callout>
          <p className="mt-2 text-[12px] text-muted">
            L'extension est une fonctionnalité optionnelle : un serveur qui ne l'implémente pas répond
            « méthode inconnue » à <Mono>events/list</Mono>. Les outils de ce serveur restent
            disponibles normalement.
          </p>
          <div className="mt-2">
            <Button variant="ghost" onClick={() => void load()} disabled={busy}>
              Revérifier
            </Button>
          </div>
        </CardBody>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardHeader
          title={"Événements MCP — " + data.events.length + " type" + (data.events.length > 1 ? "s" : "")}
          subtitle={
            "Extension " + (data.extension ?? "events") + " · révision " + (data.revision ?? "2026-07-28")
          }
          actions={
            <Button variant="ghost" onClick={() => void load()} disabled={busy}>
              {busy ? "…" : "Rafraîchir"}
            </Button>
          }
        />
        <CardBody>
          {data.events.length === 0 ? (
            <EmptyState
              title="Aucun type d'événement"
              description="Le serveur annonce l'extension mais ne déclare aucun type."
            />
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {data.events.map((event) => (
                <li key={event.name} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="mono text-[12.5px] text-accent hover:underline"
                      onClick={() => void copyName(event.name)}
                      title="Copier le nom"
                    >
                      {event.name}
                    </button>
                    <DeliveryBadges modes={event.delivery} />
                  </div>
                  {event.description ? (
                    <p className="mt-1 text-[12px] text-muted">{event.description}</p>
                  ) : null}
                  <SchemaDetails label="payloadSchema" schema={event.payloadSchema} />
                  <SchemaDetails label="inputSchema" schema={event.inputSchema} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Comment consommer ces événements" />
        <CardBody>
          <p className="text-[12px] text-muted">
            Les événements ne sont pas des outils : ils n'apparaissent ni dans <Mono>tools/list</Mono> ni
            dans <Mono>search_tools</Mono>. Un client les découvre via{" "}
            <Mono>capabilities.extensions</Mono> puis ces quatre méthodes :
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-[12px]">
            <li>
              <Mono>events/list</Mono> — les types et leur schéma de charge utile.
            </li>
            <li>
              <Mono>events/subscribe</Mono> —{" "}
              <Code>{'{ name, delivery: { mode: "webhook", url, secret } }'}</Code> ou{" "}
              <Code>{'{ mode: "poll" }'}</Code>.
            </li>
            <li>
              <Mono>events/poll</Mono> — relève les événements en mode poll.
            </li>
            <li>
              <Mono>events/unsubscribe</Mono> — ferme l'abonnement.
            </li>
          </ul>
          <p className="mt-2 text-[12px] text-muted">
            Le <Code>secret</Code> webhook doit être <Mono>whsec_</Mono> suivi de 24 à 64 octets en
            base64. Un récepteur sur une adresse privée doit figurer dans la liste d'origines autorisées
            du serveur amont.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}
