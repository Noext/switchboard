import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Regression guard for the two-column layouts.
 *
 * A CSS grid track sized as a bare `1fr` keeps its default `min-width: auto`, so its
 * minimum is the MIN-CONTENT width of whatever it holds. Any child that cannot shrink —
 * a <pre> of tool arguments (min-content = its longest line), a long unbroken id, a table
 * whose cells are nowrap — then pushes the track far past the viewport instead of
 * scrolling inside itself.
 *
 * That is exactly what happened on the feedback detail page: one failed call logged a
 * ~1.2 kpx JSON line, the left track grew to 1297px, the right column was squeezed to 166px
 * and the whole "Contexte" card laid out one character per line.
 *
 * The fix is `minmax(0, <fr>)`: the track may shrink below its content, so the scrolling
 * element inside (`.card-body .Code` is `overflow-auto`) is what overflows, not the page.
 */

const ROOT = path.resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".tsx") || full.endsWith(".css")) out.push(full);
  }
  return out;
}

/** Every `grid-cols-[...]` / `grid-template-columns: ...` value in the app and components. */
function gridTemplates(): Array<{ file: string; line: number; value: string }> {
  const found: Array<{ file: string; line: number; value: string }> = [];
  const files = [path.join(ROOT, "app"), path.join(ROOT, "components")].flatMap((d) => walk(d));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    text.split("\n").forEach((line, i) => {
      const m = /grid-cols-\[(?<v>[^\]]+)\]/.exec(line) ?? /grid-template-columns:\s*(?<v>[^;"'`]+)/.exec(line);
      if (!m?.groups?.v) return;
      found.push({ file: path.relative(ROOT, file), line: i + 1, value: m.groups.v.trim() });
    });
  }
  return found;
}

describe("two-column layouts cannot be widened by their content", () => {
  it("finds the grid templates it means to check", () => {
    const templates = gridTemplates();
    expect(templates.length).toBeGreaterThan(4);
  });

  it("sizes every fr track with minmax(0, …)", () => {
    const offenders = gridTemplates().filter(({ value }) => {
      // Split on the separators that break tracks — whitespace in CSS, `_` in Tailwind
      // arbitrary values — keeping nested minmax(...) / repeat(...) intact.
      const tracks: string[] = [];
      let depth = 0;
      let current = "";
      for (const ch of value) {
        if (ch === "(") depth += 1;
        if (ch === ")") depth -= 1;
        if ((ch === "_" || /\s/.test(ch)) && depth === 0) {
          if (current) tracks.push(current);
          current = "";
        } else {
          current += ch;
        }
      }
      if (current) tracks.push(current);

      return tracks.some((track) => /^[\d.]+fr$/.test(track));
    });

    expect(
      offenders.map((o) => o.file + ":" + o.line + "  " + o.value),
      "a bare `fr` track keeps min-width:auto and can be stretched past the viewport by " +
        "a <pre> or a long unbroken string; use minmax(0, <fr>)",
    ).toEqual([]);
  });
});