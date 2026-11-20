/**
 * Minimal TOML parser — just enough for Codex `config.toml` (`[mcp_servers.*]` tables).
 *
 * Supported: comments, `[a.b]` and `[[a.b]]` tables, dotted keys, basic ("…") and literal
 * ('…') strings, multi-line strings, integers/floats/booleans, arrays (incl. multi-line),
 * inline tables and datetimes (kept as strings). Anything else throws a `TomlError` carrying
 * the line number so the import UI can point at the offending line.
 *
 * No dependency is available for TOML (see package.json), hence this file.
 */

export class TomlError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`TOML line ${line}: ${message}`);
    this.name = "TomlError";
    this.line = line;
  }
}

export type TomlValue = string | number | boolean | TomlValue[] | { [key: string]: TomlValue };
export type TomlDocument = { [key: string]: TomlValue };

/** Strips a comment that is not inside a string. */
function stripComment(line: string): string {
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inBasic) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inBasic = false;
      continue;
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === '"') {
      inBasic = true;
      continue;
    }
    if (ch === "'") {
      inLiteral = true;
      continue;
    }
    if (ch === "#") return line.slice(0, i);
  }
  return line;
}

/** True when every bracket/brace opened on the text so far is still open. */
function isBalanced(text: string): boolean {
  let depth = 0;
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inBasic) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inBasic = false;
      continue;
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === '"') {
      inBasic = true;
      continue;
    }
    if (ch === "'") {
      inLiteral = true;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
  }
  return depth <= 0;
}

/** Parses a dotted key path: `a.b."c d"` -> ["a","b","c d"]. */
function parseKeyPath(raw: string, lineNo: number): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  const pushSegment = (value: string, quoted: boolean) => {
    if (quoted) {
      segments.push(value);
    } else {
      const trimmed = value.trim();
      if (trimmed.length === 0) throw new TomlError("empty key segment", lineNo);
      segments.push(trimmed);
    }
  };

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (quote === '"' && ch === "\\") {
        current += ch + (raw[i + 1] ?? "");
        i++;
        continue;
      }
      if (ch === quote) {
        pushSegment(quote === '"' ? unescapeBasic(current, lineNo) : current, true);
        current = "";
        quote = null;
        // A quoted segment may be followed by whitespace and then '.' or end.
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ".") {
      pushSegment(current, false);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quote) throw new TomlError("unterminated quoted key", lineNo);
  if (current.trim().length > 0) pushSegment(current, false);
  if (segments.length === 0) throw new TomlError("empty key", lineNo);
  return segments;
}

function unescapeBasic(value: string, lineNo: number): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = value[++i];
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case '"':
        out += '"';
        break;
      case "\\":
        out += "\\";
        break;
      case "u":
      case "U": {
        const len = next === "u" ? 4 : 8;
        const hex = value.slice(i + 1, i + 1 + len);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) throw new TomlError("bad unicode escape", lineNo);
        out += String.fromCodePoint(parseInt(hex, 16));
        i += len;
        break;
      }
      default:
        throw new TomlError(`unknown escape \\${next ?? ""}`, lineNo);
    }
  }
  return out;
}

class ValueParser {
  private pos = 0;
  constructor(
    private readonly text: string,
    private readonly lineNo: number,
  ) {}

  parse(): TomlValue {
    const value = this.parseValue();
    this.skipWs();
    if (this.pos < this.text.length) {
      throw new TomlError(`unexpected trailing content "${this.text.slice(this.pos)}"`, this.lineNo);
    }
    return value;
  }

  private skipWs(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
  }

  private parseValue(): TomlValue {
    this.skipWs();
    const ch = this.text[this.pos];
    if (ch === undefined) throw new TomlError("missing value", this.lineNo);

    if (ch === '"' || ch === "'") return this.parseString(ch);
    if (ch === "[") return this.parseArray();
    if (ch === "{") return this.parseInlineTable();
    return this.parseBare();
  }

  private parseString(quote: '"' | "'"): string {
    // Multi-line variants.
    if (this.text.startsWith(quote.repeat(3), this.pos)) {
      const end = this.text.indexOf(quote.repeat(3), this.pos + 3);
      if (end === -1) throw new TomlError("unterminated multi-line string", this.lineNo);
      const raw = this.text.slice(this.pos + 3, end).replace(/^\r?\n/, "");
      this.pos = end + 3;
      return quote === '"' ? unescapeBasic(raw, this.lineNo) : raw;
    }
    this.pos++;
    let raw = "";
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (quote === '"' && ch === "\\") {
        raw += ch + (this.text[this.pos + 1] ?? "");
        this.pos += 2;
        continue;
      }
      if (ch === quote) {
        this.pos++;
        return quote === '"' ? unescapeBasic(raw, this.lineNo) : raw;
      }
      raw += ch;
      this.pos++;
    }
    throw new TomlError("unterminated string", this.lineNo);
  }

  private parseArray(): TomlValue[] {
    this.pos++; // [
    const out: TomlValue[] = [];
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] === "]") {
        this.pos++;
        return out;
      }
      out.push(this.parseValue());
      this.skipWs();
      if (this.text[this.pos] === ",") {
        this.pos++;
        continue;
      }
      if (this.text[this.pos] === "]") {
        this.pos++;
        return out;
      }
      throw new TomlError("expected ',' or ']' in array", this.lineNo);
    }
  }

  private parseInlineTable(): { [key: string]: TomlValue } {
    this.pos++; // {
    const out: { [key: string]: TomlValue } = {};
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] === "}") {
        this.pos++;
        return out;
      }
      const keyStart = this.pos;
      let inStr: '"' | "'" | null = null;
      while (this.pos < this.text.length) {
        const ch = this.text[this.pos];
        if (inStr) {
          if (ch === "\\" && inStr === '"') {
            this.pos += 2;
            continue;
          }
          if (ch === inStr) inStr = null;
          this.pos++;
          continue;
        }
        if (ch === '"' || ch === "'") {
          inStr = ch;
          this.pos++;
          continue;
        }
        if (ch === "=") break;
        this.pos++;
      }
      const keyRaw = this.text.slice(keyStart, this.pos);
      if (this.text[this.pos] !== "=") throw new TomlError("expected '=' in inline table", this.lineNo);
      this.pos++;
      const path = parseKeyPath(keyRaw, this.lineNo);
      const value = this.parseValue();
      assignPath(out, path, value, this.lineNo);
      this.skipWs();
      if (this.text[this.pos] === ",") {
        this.pos++;
        continue;
      }
      if (this.text[this.pos] === "}") {
        this.pos++;
        return out;
      }
      throw new TomlError("expected ',' or '}' in inline table", this.lineNo);
    }
  }

  private parseBare(): TomlValue {
    const start = this.pos;
    while (this.pos < this.text.length && !/[\s,\]}]/.test(this.text[this.pos])) this.pos++;
    const raw = this.text.slice(start, this.pos);
    if (raw.length === 0) throw new TomlError("missing value", this.lineNo);
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^[+-]?\d[\d_]*$/.test(raw)) return Number(raw.replace(/_/g, ""));
    if (/^[+-]?(\d[\d_]*)?\.\d[\d_]*([eE][+-]?\d+)?$/.test(raw) || /^[+-]?(\d[\d_]*)([eE][+-]?\d+)$/.test(raw)) {
      return Number(raw.replace(/_/g, ""));
    }
    if (/^[+-]?(inf|nan)$/.test(raw)) return raw.endsWith("nan") ? Number.NaN : raw.startsWith("-") ? -Infinity : Infinity;
    // Datetimes and other bare scalars are kept verbatim as strings.
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw;
    throw new TomlError(`invalid bare value "${raw}"`, this.lineNo);
  }
}

function assignPath(target: { [key: string]: TomlValue }, path: string[], value: TomlValue, lineNo: number): void {
  let cursor = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const existing = cursor[key];
    if (existing === undefined) {
      const next: { [key: string]: TomlValue } = {};
      cursor[key] = next;
      cursor = next;
      continue;
    }
    if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
      throw new TomlError(`key "${path.slice(0, i + 1).join(".")}" is already a value`, lineNo);
    }
    cursor = existing as { [key: string]: TomlValue };
  }
  cursor[path[path.length - 1]] = value;
}

/** Returns the table at `path`, creating it when missing (arrays of tables return the last item). */
function ensureTable(root: TomlDocument, path: string[], lineNo: number): { [key: string]: TomlValue } {
  let cursor: { [key: string]: TomlValue } = root;
  for (const key of path) {
    const existing = cursor[key];
    if (existing === undefined) {
      const next: { [key: string]: TomlValue } = {};
      cursor[key] = next;
      cursor = next;
      continue;
    }
    if (Array.isArray(existing)) {
      const last = existing[existing.length - 1];
      if (last && typeof last === "object" && !Array.isArray(last)) {
        cursor = last as { [key: string]: TomlValue };
        continue;
      }
      throw new TomlError(`"${key}" is an array of scalars`, lineNo);
    }
    if (typeof existing !== "object" || existing === null) {
      throw new TomlError(`"${key}" is already a value`, lineNo);
    }
    cursor = existing as { [key: string]: TomlValue };
  }
  return cursor;
}

/** Parses a TOML document. Throws `TomlError` with a line number on invalid input. */
export function parseToml(source: string): TomlDocument {
  const root: TomlDocument = {};
  let current: { [key: string]: TomlValue } = root;
  const lines = source.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    const lineNo = i + 1;
    let line = stripComment(lines[i]).trim();
    i++;

    // Join continuation lines while brackets/braces stay open (multi-line arrays/tables)
    // or while a multi-line string ("\"\"\"" / ''' ) is still open.
    if (line.length > 0 && needsContinuation(line)) {
      while (i < lines.length && needsContinuation(line)) {
        line += "\n" + stripComment(lines[i]).trim();
        i++;
      }
      if (needsContinuation(line)) throw new TomlError("unbalanced brackets or unterminated string", lineNo);
    }

    const held = line;
    if (held.length === 0) continue;

    if (held.startsWith("[[")) {
      if (!held.endsWith("]]")) throw new TomlError("malformed array-of-tables header", lineNo);
      const path = parseKeyPath(held.slice(2, -2), lineNo);
      const parent = ensureTable(root, path.slice(0, -1), lineNo);
      const key = path[path.length - 1];
      const existing = parent[key];
      const item: { [k: string]: TomlValue } = {};
      if (existing === undefined) parent[key] = [item];
      else if (Array.isArray(existing)) existing.push(item);
      else throw new TomlError(`"${path.join(".")}" is already a table`, lineNo);
      current = item;
      continue;
    }

    if (held.startsWith("[")) {
      if (!held.endsWith("]")) throw new TomlError("malformed table header", lineNo);
      const path = parseKeyPath(held.slice(1, -1), lineNo);
      current = ensureTable(root, path, lineNo);
      continue;
    }

    const eq = findAssignmentEquals(held);
    if (eq === -1) throw new TomlError(`expected "key = value", got "${held}"`, lineNo);
    const keyRaw = held.slice(0, eq).trim();
    const valueText = held.slice(eq + 1).trim();
    const path = parseKeyPath(keyRaw, lineNo);
    const parser = new ValueParser(valueText, lineNo);
    assignPath(current, path, parser.parse(), lineNo);
  }

  return root;
}

/** True when the text still needs following lines: open brackets/braces or an open multi-line string. */
function needsContinuation(text: string): boolean {
  if (!isBalanced(text)) return true;
  const triples = text.match(/"""|'''/g);
  return triples !== null && triples.length % 2 === 1;
}

function findAssignmentEquals(line: string): number {
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inBasic) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === '"') inBasic = false;
      continue;
    }
    if (inLiteral) {
      if (ch === "'") inLiteral = false;
      continue;
    }
    if (ch === '"') {
      inBasic = true;
      continue;
    }
    if (ch === "'") {
      inLiteral = true;
      continue;
    }
    if (ch === "=") return i;
  }
  return -1;
}

/** Renders a flat string map as a TOML inline table (used by the export endpoint). */
export function toTomlInlineTable(record: Record<string, string>): string {
  const parts = Object.entries(record).map(([k, v]) => `"${escapeTomlString(k)}" = "${escapeTomlString(v)}"`);
  return `{ ${parts.join(", ")} }`;
}

export function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
