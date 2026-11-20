"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/input";
import { Callout, Code, Mono, Spinner } from "@/components/ui/misc";
import { useToast } from "@/components/ui/toast";
import { apiRequest, errorMessage } from "@/components/client-api";

interface PreviewServer {
  name: string;
  slug: string;
  transport: "http" | "sse" | "stdio";
  url: string | null;
  command: string | null;
  args: string[] | null;
  cwd: string | null;
  authType: string;
  envKeys: string[];
  headerKeys: string[];
  bearerTokenEnvVar: string | null;
  secrets: Array<{ location: string; key: string }>;
  hasSecrets: boolean;
  enabled: boolean;
  projects: string[];
  scope: string;
  warnings: string[];
  slugTaken: boolean;
}

interface Preview {
  format: string;
  servers: PreviewServer[];
  warnings: string[];
  counts: { servers: number; stdio: number; http: number; secrets: number };
}

interface ImportResult {
  created: string[];
  skipped: string[];
  createdSlugs: string[];
  skippedReasons: Record<string, string>;
  warnings: string[];
  needsAttention: Array<{ slug: string; reason: string }>;
}

const PLACEHOLDER_JSON = [
  "{",
  '  "mcpServers": {',
  '    "github": {',
  '      "command": "npx",',
  '      "args": ["-y", "@modelcontextprotocol/server-github"],',
  '      "env": { "GITHUB_TOKEN": "ghp_xxx" }',
  "    }",
  "  }",
  "}",
].join("\n");

/**
 * Paste -> preview -> selective import (spec §8 "Import"). The pasted payload is analysed by
 * POST /api/v1/import/preview, which never echoes a secret value; the import itself posts the
 * selected servers to POST /api/v1/import.
 */
export function ImportWizard({
  keyChoices,
  roleChoices,
  existing,
}: {
  keyChoices: Array<{ id: string; name: string }>;
  roleChoices: Array<{ id: string; name: string }>;
  existing: Array<{ slug: string; name: string }>;
}) {
  const router = useRouter();
  const toast = useToast();
  const [payload, setPayload] = React.useState("");
  const [format, setFormat] = React.useState("auto");
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [slugs, setSlugs] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ImportResult | null>(null);

  async function analyze() {
    if (!payload.trim()) {
      setError("Collez d'abord une configuration.");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body: Record<string, unknown> = { payload, preview: true };
      if (format !== "auto") body.format = format;
      const res = await apiRequest<{ preview?: Preview }>("/api/v1/import", { method: "POST", body });
      const data = res.preview ?? null;
      setPreview(data);
      if (data) {
        setSelected(new Set(data.servers.map((s) => s.name)));
        const map: Record<string, string> = {};
        for (const s of data.servers) map[s.name] = s.slug;
        setSlugs(map);
      }
    } catch (err) {
      setError(errorMessage(err));
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    if (!preview) return;
    const selection = preview.servers
      .filter((s) => selected.has(s.name))
      .map((s) => ({
        name: s.name,
        slug: slugs[s.name] ?? s.slug,
        transport: s.transport,
        url: s.url,
        command: s.command,
        args: s.args,
        cwd: s.cwd,
        authType: s.authType === "none" ? undefined : s.authType,
        enabled: s.enabled,
      }));
    if (selection.length === 0) {
      toast.push("Sélectionnez au moins un serveur.", "warn");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // The secrets of the pasted payload stay server-side: the API re-parses it when importing.
      const body: Record<string, unknown> = { payload, preview: false, selection };
      if (format !== "auto") body.format = format;
      const res = await apiRequest<ImportResult>("/api/v1/import", { method: "POST", body });
      setResult(res);
      const createdCount = res?.created?.length ?? 0;
      toast.push(createdCount + " serveur(s) importé(s).", createdCount ? "ok" : "warn");
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleAll(next: boolean) {
    if (!preview) return;
    setSelected(next ? new Set(preview.servers.map((s) => s.name)) : new Set());
  }

  const selectedCount = selected.size;
  void keyChoices;
  void roleChoices;

  return (
    <div className="flex flex-col gap-3">
      {error ? <Callout tone="bad">{error}</Callout> : null}

      <Field label="Configuration à importer" hint="Collez le contenu complet du fichier. Rien n'est enregistré avant l'import.">
        <Textarea
          rows={10}
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          placeholder={PLACEHOLDER_JSON}
          spellCheck={false}
        />
      </Field>

      <div className="flex flex-wrap items-end gap-2">
        <Field label="Format" className="w-[210px]">
          <Select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            options={[
              { value: "auto", label: "Détection automatique" },
              { value: "claude-code", label: "Claude Code (.mcp.json)" },
              { value: "claude-desktop", label: "Claude Desktop" },
              { value: "codex", label: "Codex (TOML)" },
            ]}
          />
        </Field>
        <Button variant="secondary" onClick={analyze} disabled={busy || !payload.trim()}>
          {busy ? <Spinner /> : null}
          {busy ? "Analyse…" : "Analyser"}
        </Button>
        {payload ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setPayload("");
              setPreview(null);
              setResult(null);
            }}
          >
            Vider
          </Button>
        ) : null}
      </div>

      {preview ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="accent">{preview.format}</Badge>
            <span className="text-[12px] text-muted">
              {preview.counts.servers} serveur(s) · {preview.counts.http} HTTP · {preview.counts.stdio} stdio · {preview.counts.secrets} secret(s)
              repéré(s)
            </span>
          </div>

          {preview.warnings.length > 0 ? (
            <Callout tone="warn" title="Avertissements">
              <ul className="list-disc pl-4">
                {preview.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </Callout>
          ) : null}

          <div className="flex items-center justify-between rounded border border-line bg-[hsl(var(--bg))] px-2 py-1.5">
            <Checkbox
              checked={preview.servers.length > 0 && selectedCount === preview.servers.length}
              onChange={toggleAll}
              label={"Tout sélectionner (" + preview.servers.length + ")"}
            />
            <span className="text-[11.5px] text-muted">{selectedCount} sélectionné(s)</span>
          </div>

          <div className="flex flex-col gap-1.5">
            {preview.servers.map((s) => (
              <div key={s.name} className="rounded border border-line bg-[hsl(var(--panel-2))] px-2.5 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Checkbox
                    checked={selected.has(s.name)}
                    onChange={(next) =>
                      setSelected((prev) => {
                        const copy = new Set(prev);
                        if (next) copy.add(s.name);
                        else copy.delete(s.name);
                        return copy;
                      })
                    }
                  />
                  <span className="font-medium">{s.name}</span>
                  <Badge tone={s.transport === "stdio" ? "violet" : "info"}>{s.transport}</Badge>
                  {s.hasSecrets ? <Badge tone="warn">{s.secrets.length} secret(s)</Badge> : null}
                  {s.slugTaken ? <Badge tone="bad">slug pris</Badge> : null}
                  {existing.some((e) => e.name === s.name) ? <Badge tone="neutral">nom déjà présent</Badge> : null}
                  <div className="ml-auto flex items-center gap-1.5">
                    <span className="text-[10.5px] text-muted">slug</span>
                    <Input
                      className="h-6 w-[110px] py-0.5 font-mono text-[11px]"
                      value={slugs[s.name] ?? s.slug}
                      onChange={(e) =>
                        setSlugs((prev) => ({ ...prev, [s.name]: e.target.value.replace(/[^a-z0-9]/g, "").slice(0, 12) }))
                      }
                    />
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
                  {s.transport === "stdio" ? (
                    <span className="mono">
                      {s.command} {(s.args ?? []).join(" ")}
                    </span>
                  ) : (
                    <span className="mono">{s.url}</span>
                  )}
                  {s.envKeys.length > 0 ? <span>env : {s.envKeys.join(", ")}</span> : null}
                  {s.headerKeys.length > 0 ? <span>en-têtes : {s.headerKeys.join(", ")}</span> : null}
                  {s.bearerTokenEnvVar ? <span>bearer via variable {s.bearerTokenEnvVar}</span> : null}
                  {s.projects.length > 0 ? <span>projets : {s.projects.length}</span> : null}
                </div>
                {s.warnings.length > 0 ? (
                  <ul className="mt-1 list-disc pl-4 text-[10.5px] text-warn">
                    {s.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Annuler
            </Button>
            <Button variant="primary" onClick={doImport} disabled={busy || selectedCount === 0}>
              {busy ? "Import…" : "Importer " + selectedCount + " serveur(s)"}
            </Button>
          </div>
          <p className="text-[11px] text-muted">
            Les secrets du fichier collé sont chiffrés avec la clé maître au moment de l&apos;import et ne sont jamais réaffichés. La section Accès
            de chaque serveur reste à remplir ensuite depuis sa fiche.
          </p>
        </div>
      ) : null}

      {result ? (
        <Callout tone={result.created.length > 0 ? "ok" : "warn"} title={result.created.length + " serveur(s) importé(s)"}>
          <div className="flex flex-col gap-1">
            {result.createdSlugs.length > 0 ? <div className="mono text-[11.5px]">{result.createdSlugs.join(", ")}</div> : null}
            {result.skipped.length > 0 ? (
              <ul className="list-disc pl-4 text-[11.5px]">
                {result.skipped.map((name) => (
                  <li key={name}>
                    {name} — {result.skippedReasons[name] ?? "raison inconnue"}
                  </li>
                ))}
              </ul>
            ) : null}
            {result.needsAttention.map((n) => (
              <div key={n.slug} className="text-[11.5px] text-warn">
                {n.slug} : {n.reason}
              </div>
            ))}
          </div>
        </Callout>
      ) : null}
    </div>
  );
}

/** Export the config an agent should use for one key (spec §6.4 / §9 GET /export?key=). */
export function ExportPanel({ keys }: { keys: Array<{ id: string; name: string; prefix: string }> }) {
  const [keyId, setKeyId] = React.useState(keys[0]?.id ?? "");
  const [data, setData] = React.useState<{
    mcpUrl?: string;
    snippets?: { claudeCodeCommand: string; codexToml: string; mcpJson: string };
    upstreams?: Array<{ slug: string; toolCount: number }>;
  } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const toast = useToast();

  React.useEffect(() => {
    if (!keyId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await apiRequest<typeof data>("/api/v1/export?key=" + keyId);
        if (!cancelled) setData(res);
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [keyId]);

  if (keys.length === 0) {
    return <p className="text-[12px] text-muted">Aucune clé : créez-en une pour exporter sa configuration.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <Select
        className="h-7 py-1 text-[11.5px]"
        value={keyId}
        onChange={(e) => setKeyId(e.target.value)}
        options={keys.map((k) => ({ value: k.id, label: k.name + " (" + k.prefix + "…)" }))}
      />
      {loading ? (
        <div className="flex items-center gap-2 text-[12px] text-muted">
          <Spinner /> chargement…
        </div>
      ) : data?.snippets ? (
        <div className="flex flex-col gap-2">
          <div>
            <span className="label">Claude Code</span>
            <Code className="max-h-[140px]">{data.snippets.claudeCodeCommand}</Code>
          </div>
          <div>
            <span className="label">Codex</span>
            <Code className="max-h-[140px]">{data.snippets.codexToml}</Code>
          </div>
          <div className="flex gap-1.5">
            <Button
              size="xs"
              onClick={() =>
                navigator.clipboard.writeText(data.snippets?.mcpJson ?? "").then(() => toast.push("Copié.", "ok"))
              }
            >
              Copier .mcp.json
            </Button>
            <a href={"/api/v1/export?key=" + keyId} className="btn btn-ghost btn-xs" download>
              JSON complet
            </a>
          </div>
          {data.upstreams && data.upstreams.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {data.upstreams.map((u) => (
                <span key={u.slug} className="pill mono">
                  {u.slug} · {u.toolCount}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-[12px] text-muted">
          <Mono>Export indisponible</Mono> — l&apos;API d&apos;export répondra dès que le serveur sera à jour.
        </p>
      )}
    </div>
  );
}