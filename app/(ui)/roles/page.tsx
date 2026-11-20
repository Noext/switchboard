import type { Metadata } from "next";
import Link from "next/link";
import { requireUiAuth } from "@/components/server/auth";
import { listRoles } from "@/lib/auth/grants";
import { listKeys } from "@/lib/auth/keys";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR, TableWrap, EmptyRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { loadAccessGrants } from "@/lib/auth/grants";
import { catalogFromDb } from "@/components/server/catalog-db";
import { RoleCreateForm } from "./role-create";

export const metadata: Metadata = { title: "Rôles — Switchboard" };
export const dynamic = "force-dynamic";

export default async function RolesPage() {
  await requireUiAuth();

  let roles: ReturnType<typeof listRoles> = [];
  let keys: ReturnType<typeof listKeys> = [];
  const stats = new Map<string, { upstreams: number; tools: number }>();

  try {
    roles = listRoles();
  } catch {
    roles = [];
  }
  try {
    keys = listKeys();
  } catch {
    keys = [];
  }
  try {
    const grants = loadAccessGrants({});
    const toolCount = new Map(catalogFromDb().map((u) => [u.id, u.tools.length] as const));
    for (const role of roles) {
      const own = grants.filter((g) => g.source.type === "role" && g.source.id === role.id);
      let tools = 0;
      for (const g of own) {
        tools += g.toolMode === "all" ? (toolCount.get(g.upstreamId) ?? 0) : g.tools.length;
      }
      stats.set(role.id, { upstreams: own.length, tools });
    }
  } catch {
    /* keep zeroed stats */
  }

  const keyName = new Map(keys.map((k) => [k.id, k.name]));

  return (
    <div>
      <PageHeader
        title="Rôles"
        description="Un rôle est un ensemble de droits réutilisable. Modifier un rôle met à jour toutes ses clés immédiatement."
        actions={<RoleCreateForm keyChoices={keys.map((k) => ({ id: k.id, name: k.name }))} />}
      />

      {roles.length === 0 ? (
        <Card>
          <EmptyState
            title="Aucun rôle"
            description="Exemple : « dev-wegrow » = GitHub tous les outils + Jira en lecture seule. Un rôle s'attache à plusieurs clés et se modifie en un seul endroit."
          />
        </Card>
      ) : (
        <Card>
          <CardHeader title={roles.length + " rôle(s)"} />
          <TableWrap>
            <Table zebra>
              <THead>
                <TR>
                  <TH>Nom</TH>
                  <TH>Description</TH>
                  <TH className="text-right">Clés</TH>
                  <TH className="text-right">MCP</TH>
                  <TH className="text-right">Outils</TH>
                  <TH>Clés utilisatrices</TH>
                </TR>
              </THead>
              <TBody>
                {roles.map((r) => {
                  const s = stats.get(r.id) ?? { upstreams: 0, tools: 0 };
                  return (
                    <TR key={r.id}>
                      <TD>
                        <Link href={"/roles/" + r.id} className="font-medium text-ink hover:underline">
                          {r.name}
                        </Link>
                      </TD>
                      <TD className="max-w-[380px] truncate text-[11.5px] text-muted" title={r.description ?? ""}>
                        {r.description ?? "—"}
                      </TD>
                      <TD className="text-right tabular-nums">{r.keyIds.length}</TD>
                      <TD className="text-right tabular-nums">{s.upstreams}</TD>
                      <TD className="text-right tabular-nums">{s.tools}</TD>
                      <TD>
                        <div className="flex flex-wrap gap-1">
                          {r.keyIds.length === 0 ? (
                            <span className="text-[11px] text-muted">aucune</span>
                          ) : (
                            r.keyIds.slice(0, 4).map((id) => (
                              <Link key={id} href={"/keys/" + id}>
                                <Badge tone="accent">{keyName.get(id) ?? id}</Badge>
                              </Link>
                            ))
                          )}
                          {r.keyIds.length > 4 ? <Badge tone="neutral">+{r.keyIds.length - 4}</Badge> : null}
                        </div>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </TableWrap>
        </Card>
      )}
    </div>
  );
}