import type { Metadata } from "next";
import Link from "next/link";
import { requireUiAuth } from "@/components/server/auth";
import { keyUsage } from "@/components/server/data";
import { listKeys } from "@/lib/auth/keys";
import { listRoles } from "@/lib/auth/grants";
import { effectiveAccessDb } from "@/components/server/access-db";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR, TableWrap, EmptyRow } from "@/components/ui/table";
import { relTime, keyStatus } from "@/components/format";

export const metadata: Metadata = { title: "Clés API — Switchboard" };
export const dynamic = "force-dynamic";

export default async function KeysPage() {
  await requireUiAuth();

  let keys: ReturnType<typeof listKeys> = [];
  let roles: ReturnType<typeof listRoles> = [];
  let usage = new Map<string, { calls24h: number; calls7d: number; denied24h: number; lastCallAt: number | null }>();
  const counts = new Map<string, { upstreams: number; tools: number }>();

  try {
    keys = listKeys();
  } catch {
    keys = [];
  }
  try {
    roles = listRoles();
  } catch {
    roles = [];
  }
  try {
    usage = keyUsage();
  } catch {
    usage = new Map();
  }
  for (const key of keys) {
    try {
      const access = effectiveAccessDb(key.id);
      let tools = 0;
      let upstreams = 0;
      for (const entry of Object.values(access?.upstreams ?? {})) {
        if (!entry.hasAccess) continue;
        upstreams += 1;
        tools += entry.tools.length;
      }
      counts.set(key.id, { upstreams, tools });
    } catch {
      counts.set(key.id, { upstreams: 0, tools: 0 });
    }
  }

  const roleName = new Map(roles.map((r) => [r.id, r.name]));
  const active = keys.filter((k) => keyStatus(k) === "active").length;

  return (
    <div>
      <PageHeader
        title="Clés API"
        description="Une clé par agent. Une clé ne voit et n'appelle que ce que ses droits autorisent, et rien n'est autorisé par défaut."
        actions={
          <>
            <Link href="/access-matrix" className="btn btn-secondary btn-sm">
              Matrice d&apos;accès
            </Link>
            <Link href="/keys/new" className="btn btn-primary btn-sm">
              Créer une clé
            </Link>
          </>
        }
      />

      {keys.length === 0 ? (
        <Card>
          <EmptyState
            title="Aucune clé API"
            description="Créez une clé par agent (claude-laptop, claude-box, codex…). Le secret n'est affiché qu'une seule fois, avec les snippets de configuration."
            action={
              <Link href="/keys/new" className="btn btn-primary btn-sm">
                Créer la première clé
              </Link>
            }
          />
        </Card>
      ) : (
        <Card>
          <CardHeader title={keys.length + " clé(s)"} subtitle={active + " active(s)"} />
          <TableWrap>
            <Table zebra>
              <THead>
                <TR>
                  <TH>Nom</TH>
                  <TH>Préfixe</TH>
                  <TH>Rôles</TH>
                  <TH>Mode</TH>
                  <TH className="text-right">MCP</TH>
                  <TH className="text-right">Outils</TH>
                  <TH className="text-right">Appels 24 h</TH>
                  <TH className="text-right">Refus 24 h</TH>
                  <TH>Dernière utilisation</TH>
                  <TH>Statut</TH>
                </TR>
              </THead>
              <TBody>
                {keys.map((k) => {
                  const status = keyStatus(k);
                  const c = counts.get(k.id) ?? { upstreams: 0, tools: 0 };
                  const u = usage.get(k.id);
                  return (
                    <TR key={k.id}>
                      <TD>
                        <Link href={"/keys/" + k.id} className="font-medium text-ink hover:underline">
                          {k.name}
                        </Link>
                        {k.scope === "admin" ? <Badge tone="warn" className="ml-1.5">admin</Badge> : null}
                        {k.description ? (
                          <div className="max-w-[280px] truncate text-[11px] text-muted" title={k.description}>
                            {k.description}
                          </div>
                        ) : null}
                      </TD>
                      <TD className="mono text-[11.5px] text-muted">{k.prefix}…</TD>
                      <TD>
                        {k.roleIds.length === 0 ? (
                          <span className="text-[11px] text-muted">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {k.roleIds.slice(0, 3).map((id) => (
                              <Link key={id} href={"/roles/" + id}>
                                <Badge tone="violet">{roleName.get(id) ?? id}</Badge>
                              </Link>
                            ))}
                            {k.roleIds.length > 3 ? <Badge tone="neutral">+{k.roleIds.length - 3}</Badge> : null}
                          </div>
                        )}
                      </TD>
                      <TD>
                        <Badge tone={k.exposureMode === "discovery" ? "info" : "neutral"}>{k.exposureMode}</Badge>
                      </TD>
                      <TD className="text-right tabular-nums">{c.upstreams}</TD>
                      <TD className="text-right tabular-nums">{c.tools}</TD>
                      <TD className="text-right tabular-nums text-muted">{u?.calls24h ?? 0}</TD>
                      <TD className="text-right tabular-nums">
                        {(u?.denied24h ?? 0) > 0 ? <span className="text-warn">{u?.denied24h}</span> : <span className="text-muted">0</span>}
                      </TD>
                      <TD className="whitespace-nowrap text-[11.5px] text-muted" title={k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString("fr-FR") : ""}>
                        {relTime(k.lastUsedAt ?? u?.lastCallAt ?? null)}
                      </TD>
                      <TD>
                        <Badge tone={status === "active" ? "ok" : status === "revoked" ? "bad" : "warn"}>
                          {status === "active" ? "active" : status === "revoked" ? "révoquée" : "expirée"}
                        </Badge>
                        {k.expiresAt && status === "active" ? (
                          <div className="mt-0.5 whitespace-nowrap text-[10.5px] text-muted">
                            expire {relTime(k.expiresAt)}
                          </div>
                        ) : null}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableWrap>
        </Card>
      )}

      {keys.length > 0 && active === 0 ? (
        <div className="mt-3">
          <Card>
            <EmptyState title="Toutes les clés sont inactives" description="Révoquées ou expirées : aucun agent ne peut se connecter à /mcp." />
          </Card>
        </div>
      ) : null}
      {active === 0 ? null : null}
    </div>
  );
}