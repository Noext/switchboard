import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUiAuth } from "@/components/server/auth";
import { editorData, grantsForSubject } from "@/components/server/access-data";
import { getRole, listRoles } from "@/lib/auth/grants";
import { listKeys } from "@/lib/auth/keys";
import { Badge } from "@/components/ui/badge";
import { Card, CardBody, CardHeader, EmptyState, PageHeader, Stat } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR, TableWrap, EmptyRow } from "@/components/ui/table";
import { TabNav } from "@/components/ui/tabs";
import { Mono } from "@/components/ui/misc";
import { absTime, keyStatus } from "@/components/format";
import { RoleActions, RoleAccessTab, RoleKeysTab } from "./role-tabs";

export const metadata: Metadata = { title: "Fiche rôle — Switchboard" };
export const dynamic = "force-dynamic";

const TABS = [
  { id: "rights", label: "Droits" },
  { id: "keys", label: "Clés" },
  { id: "grants", label: "Liste des droits" },
];

export default async function RoleDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireUiAuth();
  const { id } = await params;
  const { tab } = await searchParams;
  const activeTab = TABS.some((t) => t.id === tab) ? (tab as string) : "rights";

  let role: ReturnType<typeof getRole> = null;
  try {
    role = getRole(id);
  } catch {
    role = null;
  }
  if (!role) notFound();

  let upstreams: ReturnType<typeof editorData>["upstreams"] = [];
  let grants: ReturnType<typeof grantsForSubject> = [];
  let keys: ReturnType<typeof listKeys> = [];
  try {
    upstreams = editorData().upstreams;
    grants = grantsForSubject("role", id);
    keys = listKeys();
  } catch {
    /* fresh install */
  }

  const users = keys.filter((k) => role!.keyIds.includes(k.id));
  const grantsByUpstream = new Map(grants.map((g) => [g.upstreamId, g]));
  const toolTotal = grants.reduce((acc, g) => {
    if (g.mode === "all") return acc + (upstreams.find((u) => u.id === g.upstreamId)?.tools.length ?? 0);
    return acc + g.tools.length;
  }, 0);

  return (
    <div>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-2">{role.name}<Badge tone="violet">rôle</Badge></span>}
        description={role.description ?? undefined}
        breadcrumb={
          <span>
            <Link href="/roles" className="link">
              Rôles
            </Link>{" "}
            / <span className="mono">{role.name}</span>
          </span>
        }
        actions={<RoleActions roleId={role.id} name={role.name} description={role.description} />}
      />

      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="Clés utilisatrices" value={users.length} hint={users.map((k) => k.name).join(", ") || "aucune"} />
        <Stat label="MCP accordés" value={grants.length} hint={upstreams.length + " au catalogue"} />
        <Stat label="Outils accordés" value={toolTotal} />
        <Stat label="Créé" value={absTime(role.createdAt).split(" ")[0] ?? "—"} hint={absTime(role.createdAt)} />
      </div>

      <TabNav tabs={TABS} active={activeTab} basePath={"/roles/" + role.id} />

      <div className="mt-3">
        {activeTab === "rights" ? (
          <Card>
            <CardHeader
              title="Droits du rôle"
              subtitle="Ces droits s'appliquent à toutes les clés qui portent ce rôle. Chaque clé peut ensuite retirer un outil."
            />
            <CardBody>
              <RoleAccessTab roleId={role.id} upstreams={upstreams} grants={grants} />
            </CardBody>
          </Card>
        ) : null}

        {activeTab === "keys" ? (
          <Card>
            <CardHeader title="Clés utilisant ce rôle" subtitle="Cocher/décocher applique immédiatement les droits à la clé concernée." />
            <CardBody>
              <RoleKeysTab
                roleId={role.id}
                keys={keys.map((k) => ({ id: k.id, name: k.name, status: keyStatus(k) }))}
                selected={role.keyIds}
              />
            </CardBody>
          </Card>
        ) : null}

        {activeTab === "grants" ? (
          <Card>
            <CardHeader title="Liste des droits" subtitle="Un droit par MCP." />
            <CardBody className="p-0">
              <TableWrap>
                <Table>
                  <THead>
                    <TR>
                      <TH>MCP</TH>
                      <TH>Mode</TH>
                      <TH className="text-right">Outils</TH>
                      <TH>Prompts</TH>
                      <TH>Ressources</TH>
                      <TH>Détail</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {grants.length === 0 ? (
                      <EmptyRow colSpan={6}>Ce rôle n&apos;a encore aucun droit.</EmptyRow>
                    ) : (
                      grants.map((g) => {
                        const up = upstreams.find((u) => u.id === g.upstreamId);
                        return (
                          <TR key={g.upstreamId}>
                            <TD>
                              <Mono className="text-[11.5px]">{up?.slug ?? g.upstreamId}</Mono>
                              {up ? <span className="ml-1.5 text-[11px] text-muted">{up.name}</span> : null}
                            </TD>
                            <TD>{g.mode === "all" ? <Badge tone="ok">tous</Badge> : <Badge tone="info">sélection</Badge>}</TD>
                            <TD className="text-right tabular-nums">
                              {g.mode === "all" ? up?.tools.length ?? 0 : g.tools.length}
                            </TD>
                            <TD>{g.prompts ? <Badge tone="ok">oui</Badge> : <span className="text-[11px] text-muted">non</span>}</TD>
                            <TD>{g.resources ? <Badge tone="ok">oui</Badge> : <span className="text-[11px] text-muted">non</span>}</TD>
                            <TD className="max-w-[420px] truncate text-[11px] text-muted" title={g.tools.join(", ")}>
                              {g.mode === "all" ? "tous les outils, y compris futurs" : g.tools.join(", ") || "aucun"}
                            </TD>
                          </TR>
                        );
                      })
                    )}
                  </TBody>
                </Table>
              </TableWrap>
            </CardBody>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
