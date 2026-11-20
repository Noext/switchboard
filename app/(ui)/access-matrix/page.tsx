import type { Metadata } from "next";
import { requireUiAuth } from "@/components/server/auth";
import { accessMatrixDb } from "@/components/server/access-db";
import { editorData } from "@/components/server/access-data";
import { getDb } from "@/lib/db";
import { grants, grantTools, keyDenies } from "@/lib/db/schema";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui/card";
import { MatrixGrid, type MatrixRowData, type MatrixUpstream } from "./matrix-grid";

export const metadata: Metadata = { title: "Matrice d'accès — Switchboard" };
export const dynamic = "force-dynamic";

export default async function AccessMatrixPage() {
  await requireUiAuth();

  let upstreams: MatrixUpstream[] = [];
  let rows: MatrixRowData[] = [];
  let editor: ReturnType<typeof editorData> = { upstreams: [] };

  // Row data comes from the DB helpers (never the process-local catalog snapshot).
  try {
    const matrix = accessMatrixDb();
    upstreams = matrix.upstreams;
    rows = matrix.rows;
  } catch {
    upstreams = [];
    rows = [];
  }
  try {
    editor = editorData();
  } catch {
    editor = { upstreams: [] };
  }

  try {
    const db = getDb();
    const grantRows = db.select().from(grants).all();
    const toolRows = db.select().from(grantTools).all();
    const denyRows = db.select().from(keyDenies).all();
    for (const row of rows) {
      const own = grantRows.filter((g) => g.subjectType === row.subjectType && g.subjectId === row.subjectId);
      row.grants = own.map((g) => ({
        upstreamId: g.upstreamId,
        mode: g.toolMode,
        tools: toolRows.filter((t) => t.grantId === g.id).map((t) => t.toolName),
        prompts: g.prompts,
        resources: g.resources,
      }));
      row.denies =
        row.subjectType === "key"
          ? denyRows.filter((d) => d.keyId === row.subjectId).map((d) => ({ upstreamId: d.upstreamId, toolName: d.toolName }))
          : [];
    }
  } catch {
    /* the grid still works without the prefilled grants */
  }

  const keyCount = rows.filter((r) => r.subjectType === "key").length;
  const roleCount = rows.filter((r) => r.subjectType === "role").length;

  return (
    <div>
      <PageHeader
        title="Matrice d'accès"
        description="Vue d'ensemble des droits : lignes = clés et rôles, colonnes = MCP. Cliquez sur une cellule pour modifier les outils."
        actions={
          <a href="/api/v1/access-matrix?format=csv" className="btn btn-secondary btn-sm" download>
            Exporter en CSV
          </a>
        }
      />

      {upstreams.length === 0 || rows.length === 0 ? (
        <Card>
          <EmptyState
            title={upstreams.length === 0 ? "Aucun MCP dans le catalogue" : "Aucune clé ni rôle"}
            description={
              upstreams.length === 0
                ? "Ajoutez un serveur MCP pour commencer à distribuer des droits. La matrice affiche une colonne par MCP."
                : "Créez une clé API ou un rôle, puis accordez-lui l'accès depuis cette matrice."
            }
          />
        </Card>
      ) : (
        <Card>
          <CardHeader
            title={rows.length + " ligne(s) × " + upstreams.length + " MCP"}
            subtitle={keyCount + " clé(s) · " + roleCount + " rôle(s)"}
          />
          <MatrixGrid upstreams={upstreams} rows={rows} editorUpstreams={editor.upstreams} />
        </Card>
      )}
    </div>
  );
}
