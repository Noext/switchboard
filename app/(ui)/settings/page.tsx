import type { Metadata } from "next";
import { requireUiAuth } from "@/components/server/auth";
import { getSettings } from "@/lib/settings";
import { config } from "@/lib/config";
import { isMasterKeyFromFile, masterKeyExists } from "@/lib/crypto";
import { getDb } from "@/lib/db";
import { callLogs } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, PageHeader } from "@/components/ui/card";
import { Callout, Code } from "@/components/ui/misc";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = { title: "Paramètres — Switchboard" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  await requireUiAuth();

  let settings = {
    publicUrl: "",
    feedbackEnabled: true,
    appriseUrl: "",
    appriseEnabled: false,
    logRetentionDays: 30,
    logRetentionRows: 100_000,
    discoveryThreshold: 60,
  };
  let keyState = { present: false, fromFile: false };
  let callCount = 0;

  try {
    settings = getSettings();
    keyState = { present: masterKeyExists(), fromFile: isMasterKeyFromFile() };
    callCount = getDb().select({ n: sql<number>`count(*)` }).from(callLogs).get()?.n ?? 0;
  } catch {
    /* fresh install */
  }

  const effectivePublicUrl = settings.publicUrl || config.publicUrl;

  return (
    <div>
      <PageHeader
        title="Paramètres"
        description="URL publique, rétention des journaux, notifications Apprise, outil report_feedback, seuil de découverte et état de la clé maître."
      />

      <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
        <SettingsForm initial={settings} envPublicUrl={config.publicUrl} />

        <div className="flex flex-col gap-3">
          <Card>
            <CardHeader title="Clé maître" subtitle="Chiffre les secrets amont (AES-256-GCM)." />
            <CardBody className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={keyState.present ? "ok" : "bad"}>{keyState.present ? "présente" : "absente"}</Badge>
                <span className="text-[11.5px] text-muted">
                  {keyState.fromFile
                    ? "fournie par data/master.key"
                    : keyState.present
                      ? "fournie par SWITCHBOARD_MASTER_KEY"
                      : "sera générée au premier besoin"}
                </span>
              </div>
              <Code>{config.masterKeyPath}</Code>
              <Callout tone="warn" title="Sans cette clé, les secrets sont perdus">
                Sauvegardez <span className="mono">data/master.key</span> avec la base <span className="mono">switchboard.db</span>. Une restauration
                sans ce fichier rend les tokens amont et les credentials OAuth illisibles — il faut les saisir à nouveau.
              </Callout>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Mot de passe admin" subtitle="Défini par l'environnement, jamais affiché." />
            <CardBody className="flex flex-col gap-2">
              <dl className="kv">
                <dt>Variable</dt>
                <dd className="mono text-[11.5px]">SWITCHBOARD_ADMIN_PASSWORD</dd>
                <dt>Cookie</dt>
                <dd>
                  <span className="mono">sb_admin</span> — signé HMAC, HttpOnly, SameSite=Lax, 7 jours
                </dd>
                <dt>Session</dt>
                <dd>
                  <span className="mono">SWITCHBOARD_SECRET</span> signe les cookies ; le changer déconnecte toutes les sessions.
                </dd>
              </dl>
              <Callout tone="info" title="Pour changer le mot de passe">
                Modifiez <span className="mono">SWITCHBOARD_ADMIN_PASSWORD</span> dans le fichier <span className="mono">.env</span> du conteneur puis
                redémarrez-le. Aucun redémarrage à chaud n&apos;est exposé dans l&apos;interface, et c&apos;est volontaire.
              </Callout>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Environnement" />
            <CardBody>
              <dl className="kv">
                <dt>URL publique</dt>
                <dd className="mono text-[11.5px]">{effectivePublicUrl}</dd>
                <dt>Endpoint MCP</dt>
                <dd className="mono text-[11.5px]">
                  {effectivePublicUrl.replace(/\/$/, "")}
                  <span className="text-accent">/mcp</span>
                </dd>
                <dt>Données</dt>
                <dd className="mono text-[11.5px]">{config.dataDir}</dd>
                <dt>Base</dt>
                <dd className="mono text-[11.5px]">{config.dbPath}</dd>
                <dt>Port</dt>
                <dd className="mono text-[11.5px]">{config.port}</dd>
                <dt>Mode</dt>
                <dd>{config.isProd ? "production" : "développement"}</dd>
                <dt>Niveau de log</dt>
                <dd className="mono text-[11.5px]">{config.logLevel}</dd>
              </dl>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Journal des appels" />
            <CardBody>
              <dl className="kv">
                <dt>Lignes</dt>
                <dd>{callCount.toLocaleString("fr-FR")}</dd>
                <dt>Rétention</dt>
                <dd>
                  {settings.logRetentionDays} jours ou {settings.logRetentionRows.toLocaleString("fr-FR")} lignes (le premier atteint)
                </dd>
                <dt>Purge</dt>
                <dd className="text-[11.5px] text-muted">
                  La purge tourne périodiquement côté serveur. Les aperçus sont tronqués à 2 Ko et les secrets connus masqués.
                </dd>
              </dl>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
