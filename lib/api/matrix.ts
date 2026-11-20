import { getDb } from "../db";
import { grants } from "../db/schema";
import { accessMatrix } from "../auth/grants";
import type { SubjectType } from "../types";

/**
 * Access-matrix read model with the grant id attached to each cell.
 *
 * `accessMatrix()` in lib/auth/grants.ts returns the cell kinds but not the grant row id, and the
 * UI's rights editor needs it to DELETE a grant ("Aucun accès" switch). Enriching here keeps the
 * pure helper untouched and gives the editor a single endpoint to resolve ids from.
 */

export interface MatrixCell {
  kind: "all" | "selected" | "none" | "denied";
  selected: number;
  total: number;
  toolNames: string[];
  /** Grant row id when this subject has a grant on that upstream, else null. */
  grantId: string | null;
}

export interface MatrixRow {
  subjectType: SubjectType;
  subjectId: string;
  label: string;
  cells: Record<string, MatrixCell>;
}

export function matrixWithGrantIds(): {
  upstreams: Array<{ id: string; slug: string; name: string; toolCount: number }>;
  rows: MatrixRow[];
} {
  const base = accessMatrix();
  const db = getDb();
  const grantRows = db.select().from(grants).all();
  const grantIdByKey = new Map<string, string>();
  for (const g of grantRows) grantIdByKey.set(`${g.subjectType}|${g.subjectId}|${g.upstreamId}`, g.id);

  const rows: MatrixRow[] = base.rows.map((row) => {
    const cells: Record<string, MatrixCell> = {};
    for (const [upstreamId, cell] of Object.entries(row.cells)) {
      cells[upstreamId] = {
        kind: cell.kind,
        selected: cell.selected,
        total: cell.total,
        toolNames: cell.toolNames,
        grantId: grantIdByKey.get(`${row.subjectType}|${row.subjectId}|${upstreamId}`) ?? null,
      };
    }
    return { subjectType: row.subjectType, subjectId: row.subjectId, label: row.label, cells };
  });

  return { upstreams: base.upstreams, rows };
}

/** The matrix row for one subject, or null. */
export function matrixRowFor(subjectType: SubjectType, subjectId: string): MatrixRow | null {
  return matrixWithGrantIds().rows.find((r) => r.subjectType === subjectType && r.subjectId === subjectId) ?? null;
}
