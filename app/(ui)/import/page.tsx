import type { Metadata } from "next";
import { requireUiAuth } from "@/components/server/auth";
import { subjectChoices } from "@/components/server/access-data";
import { listUpstreamRows } from "@/components/server/data";
import { listKeys } from "@/lib/auth/keys";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { ImportWizard, ExportPanel } from "./import-wizard";

export const metadata: Metadata = { title: "Import — Switchboard" };
export const dynamic = "force-dynamic";

export default async function ImportPage() {
  await requireUiAuth();

  let existing: Array<{ slug: string; name: string }> = [];
  let choices: ReturnType<typeof subjectChoices> = { keys: [], roles: [] };
  let keys: Array<{ id: string; name: string; prefix: string }> = [];
  try {
    existing = listUpstreamRows().map((u) => ({ slug: u.slug, name: u.name }));
    choices = subjectChoices();
    keys = listKeys().map((k) => ({ id: k.id, name: k.name, prefix: k.prefix }));
  } catch {
    /* fresh install */
  }

  return (
    <div>
      <PageHeader
        title="Import / export"
        description="Collez un .mcp.json, un ~/.claude.json, un claude_desktop_config.json ou un config.toml Codex. Aperçu, secrets repérés, import sélectif."
      />
      <div className="grid gap-3 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader
            title="Importer une configuration"
            subtitle="Les valeurs secrètes ne sont jamais renvoyées par l'aperçu : seuls les noms apparaissent."
          />
          <CardBody>
            <ImportWizard keyChoices={choices.keys} roleChoices={choices.roles} existing={existing} />
          </CardBody>
        </Card>
        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader title="Formats reconnus" />
            <CardBody className="flex flex-col gap-2 text-[12px]">
              <div>
                <span className="label">Claude Code</span>
                <span className="text-muted">
                  <span className="mono">.mcp.json</span>, <span className="mono">~/.claude.json</span> — serveurs globaux et par projet
                  (<span className="mono">projects[*].mcpServers</span>).
                </span>
              </div>
              <div>
                <span className="label">Claude Desktop</span>
                <span className="text-muted">
                  <span className="mono">claude_desktop_config.json</span> — serveurs stdio uniquement.
                </span>
              </div>
              <div>
                <span className="label">Codex</span>
                <span className="text-muted">
                  <span className="mono">~/.codex/config.toml</span> — tables <span className="mono">[mcp_servers.*]</span>.
                </span>
              </div>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Exporter la vue d'une clé" subtitle="La config que l'agent concerné devrait utiliser." />
            <CardBody>
              <ExportPanel keys={keys} />
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
