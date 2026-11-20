import type { Metadata } from "next";
import Link from "next/link";
import { requireUiAuth } from "@/components/server/auth";
import { editorData } from "@/components/server/access-data";
import { listRoles } from "@/lib/auth/grants";
import { listKeys } from "@/lib/auth/keys";
import { PageHeader } from "@/components/ui/card";
import { KeyWizard } from "./key-wizard";

export const metadata: Metadata = { title: "Créer une clé — Switchboard" };
export const dynamic = "force-dynamic";

export default async function NewKeyPage() {
  await requireUiAuth();

  let roles: Array<{ id: string; name: string; description: string | null }> = [];
  let upstreams: ReturnType<typeof editorData>["upstreams"] = [];
  let copyable: Array<{ id: string; name: string }> = [];
  try {
    roles = listRoles().map((r) => ({ id: r.id, name: r.name, description: r.description }));
    upstreams = editorData().upstreams;
    copyable = listKeys().map((k) => ({ id: k.id, name: k.name }));
  } catch {
    /* fresh install */
  }

  return (
    <div>
      <PageHeader
        title="Créer une clé API"
        description="Trois étapes : identité, droits initiaux, puis le récapitulatif avec le secret affiché une seule fois et les snippets d'installation."
        breadcrumb={
          <span>
            <Link href="/keys" className="link">
              Clés API
            </Link>{" "}
            / Nouvelle
          </span>
        }
      />
      <KeyWizard roles={roles} upstreams={upstreams} copyableKeys={copyable} />
    </div>
  );
}
