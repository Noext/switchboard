import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireUiAuth } from "@/components/server/auth";
import { getUpstreamRow } from "@/components/server/data";
import { PageHeader } from "@/components/ui/card";
import { UpstreamForm } from "../../upstream-form";

export const metadata: Metadata = { title: "Éditer un serveur — Switchboard" };
export const dynamic = "force-dynamic";

export default async function EditServerPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUiAuth();
  const { id } = await params;

  let row: ReturnType<typeof getUpstreamRow> = null;
  try {
    row = getUpstreamRow(id);
  } catch {
    row = null;
  }
  if (!row) notFound();

  return (
    <div>
      <PageHeader
        title={"Éditer " + row.name}
        description="Les secrets ne sont jamais réaffichés : laissez vide pour les conserver, saisissez une nouvelle valeur pour la remplacer."
        breadcrumb={
          <span>
            <Link href="/servers" className="link">
              Serveurs
            </Link>{" "}
            /{" "}
            <Link href={"/servers/" + row.id} className="mono link">
              {row.slug}
            </Link>{" "}
            / Éditer
          </span>
        }
      />
      <UpstreamForm
        mode="edit"
        upstreamId={row.id}
        initial={{
          name: row.name,
          slug: row.slug,
          description: row.description ?? "",
          transport: row.transport,
          url: row.url ?? "",
          command: row.command ?? "",
          args: (row.args ?? []).join(" "),
          cwd: row.cwd ?? "",
          authType: row.authType,
          enabled: row.enabled,
          startMode: row.startMode,
          idleStopMinutes: row.idleStopMinutes,
          callTimeoutSeconds: row.callTimeoutSeconds,
        }}
      />
    </div>
  );
}
