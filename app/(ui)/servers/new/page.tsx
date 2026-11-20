import type { Metadata } from "next";
import { requireUiAuth } from "@/components/server/auth";
import { subjectChoices } from "@/components/server/access-data";
import { PageHeader } from "@/components/ui/card";
import { UpstreamForm } from "../upstream-form";
import Link from "next/link";

export const metadata: Metadata = { title: "Ajouter un serveur — Switchboard" };
export const dynamic = "force-dynamic";

export default async function NewServerPage() {
  await requireUiAuth();

  let choices: ReturnType<typeof subjectChoices> = { keys: [], roles: [] };
  try {
    choices = subjectChoices();
  } catch {
    choices = { keys: [], roles: [] };
  }

  return (
    <div>
      <PageHeader
        title="Ajouter un serveur MCP"
        description="La passerelle se connecte au serveur amont, agrège ses outils et les expose sous le préfixe du slug choisi."
        breadcrumb={
          <span>
            <Link href="/servers" className="link">
              Serveurs
            </Link>{" "}
            / Nouveau
          </span>
        }
      />
      <UpstreamForm mode="create" keyChoices={choices.keys} roleChoices={choices.roles} />
    </div>
  );
}
