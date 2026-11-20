import { guardResponse, json, requireAdmin } from "@/lib/api/guard";
import { matrixWithGrantIds } from "@/lib/api/matrix";

/**
 * GET /api/v1/access-matrix?subject=key|role&subjectId=&format=json|csv
 *   spec §8 "Matrice d'accès": rows = keys (and roles), columns = MCPs.
 *   -> {
 *        upstreams: [{ id, slug, name, toolCount }],
 *        rows: [{ subjectType: "key"|"role", subjectId, label,
 *                 cells: { [upstreamId]: { kind: "all"|"selected"|"none"|"denied",
 *                                          selected, total, toolNames[], grantId } } }],
 *        row: MatrixRow | null,   // the single row when ?subjectId= is given (rights editor)
 *        legend: { all: "●", selected: "◐", none: "○", denied: "⊘" }
 *      }
 *   `grantId` lets the rights editor DELETE the grant behind a cell; it is null when the
 *   subject has no grant on that upstream.
 *   ?format=csv returns text/csv (one row per subject).
 */
export async function GET(req: Request) {
  const guard = await requireAdmin(req);
  if (!guard.ok) return guardResponse(guard);
  const url = new URL(req.url);
  const subjectFilter = url.searchParams.get("subject");
  const subjectId = url.searchParams.get("subjectId");
  const matrix = matrixWithGrantIds();

  const rows = subjectFilter ? matrix.rows.filter((r) => r.subjectType === subjectFilter) : matrix.rows;
  const row = subjectId
    ? matrix.rows.find((r) => r.subjectId === subjectId && (!subjectFilter || r.subjectType === subjectFilter)) ?? null
    : null;

  if (url.searchParams.get("format") === "csv") {
    const header = ["subjectType", "subject", ...matrix.upstreams.map((u) => u.slug)].join(",");
    const lines = [header];
    for (const entry of rows) {
      const cells = matrix.upstreams.map((u) => {
        const cell = entry.cells[u.id];
        if (!cell || cell.kind === "none") return "";
        if (cell.kind === "all") return "all";
        return `${cell.selected}/${cell.total}`;
      });
      lines.push([entry.subjectType, JSON.stringify(entry.label), ...cells].join(","));
    }
    return new Response(lines.join("\n") + "\n", {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="access-matrix.csv"`,
        "cache-control": "no-store",
      },
    });
  }

  return json({
    upstreams: matrix.upstreams,
    rows,
    row,
    legend: { all: "●", selected: "◐", none: "○", denied: "⊘" },
  });
}
