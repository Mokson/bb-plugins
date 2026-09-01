// A strict YAML subset, parsed in-process.
//
// Why not a library: this plugin ships one runtime dependency (zod), and the
// case files are a closed format WE author. The subset below covers exactly
// what `cases.ts` needs — block maps, block and flow sequences, flow maps of
// scalars, quoted and plain scalars, comments — and REFUSES everything else
// with a line number rather than guessing. A silent misparse of an assertion
// is worse than a failed load: it would turn a green eval into a lie.
//
// Deliberately absent, and rejected loudly: anchors and aliases, tags,
// multiple documents, block scalars (`|`, `>`), and multi-line plain scalars.

export class YamlError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = "YamlError";
  }
}

/** A source line that carries content, with its indent and 1-based number. */
interface Line {
  indent: number;
  text: string;
  number: number;
}

const UNSUPPORTED: ReadonlyArray<{ probe: RegExp; why: string }> = [
  { probe: /^%/, why: "directives are not supported" },
  { probe: /^---|^\.\.\./, why: "document markers are not supported" },
  { probe: /(^|\s)[&*][A-Za-z0-9_-]+/, why: "anchors and aliases are not supported" },
  { probe: /(^|\s)!!?[A-Za-z]/, why: "tags are not supported" },
  { probe: /:\s*[|>][-+0-9]*\s*$/, why: "block scalars are not supported" },
];

function scan(source: string): Line[] {
  const lines: Line[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const number = index + 1;
    // A `#` only opens a comment at line start or after whitespace, so a `#`
    // inside a regex assertion (`text_regex: "^#\\d+"`) survives. Quotes are
    // respected so a `#` inside a quoted scalar is data.
    const text = stripComment(raw).trimEnd();
    if (text.trim() === "") return;
    const indent = text.length - text.trimStart().length;
    if (/\t/.test(text.slice(0, indent))) {
      throw new YamlError("tabs may not indent", number);
    }
    const body = text.trimStart();
    for (const { probe, why } of UNSUPPORTED) {
      if (probe.test(body)) throw new YamlError(why, number);
    }
    lines.push({ indent, text: body, number });
  });
  return lines;
}

function stripComment(raw: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(raw[i - 1] ?? ""))) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

/** Parse a YAML document into plain JSON values. Throws `YamlError`. */
export function parseYaml(source: string): unknown {
  const lines = scan(source);
  if (lines.length === 0) return null;
  const [value, next] = parseBlock(lines, 0, lines[0]!.indent);
  if (next < lines.length) {
    throw new YamlError("unexpected content after the document", lines[next]!.number);
  }
  return value;
}

/** Parse every line at `indent` (and deeper) starting at `start`. */
function parseBlock(lines: Line[], start: number, indent: number): [unknown, number] {
  const first = lines[start];
  if (!first) throw new YamlError("unexpected end of input", lines.at(-1)?.number ?? 1);
  return first.text.startsWith("- ") || first.text === "-"
    ? parseSequence(lines, start, indent)
    : parseMapping(lines, start, indent);
}

function parseSequence(lines: Line[], start: number, indent: number): [unknown[], number] {
  const items: unknown[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlError("unexpected indentation in a sequence", line.number);
    }
    if (!line.text.startsWith("- ") && line.text !== "-") {
      throw new YamlError("expected a sequence item", line.number);
    }
    const rest = line.text === "-" ? "" : line.text.slice(2).trim();
    if (rest === "") {
      // `-` alone: the item is the nested block beneath it.
      const next = lines[i + 1];
      if (!next || next.indent <= indent) {
        throw new YamlError("sequence item has no value", line.number);
      }
      const [value, after] = parseBlock(lines, i + 1, next.indent);
      items.push(value);
      i = after;
      continue;
    }
    // `- key: value` opens an inline map whose remaining keys are indented to
    // where the key text began, not to the dash.
    const inlineIndent = indent + (line.text.length - line.text.slice(2).length);
    if (isMappingEntry(rest)) {
      const synthetic: Line[] = [{ indent: inlineIndent, text: rest, number: line.number }];
      let j = i + 1;
      while (j < lines.length && lines[j]!.indent >= inlineIndent) {
        synthetic.push(lines[j]!);
        j += 1;
      }
      const [value, consumed] = parseMapping(synthetic, 0, inlineIndent);
      if (consumed !== synthetic.length) {
        throw new YamlError("unexpected indentation in a sequence item", line.number);
      }
      items.push(value);
      i = j;
      continue;
    }
    items.push(parseScalar(rest, line.number));
    i += 1;
  }
  if (items.length === 0) {
    throw new YamlError("empty sequence", lines[start]!.number);
  }
  return [items, i];
}

/** True when the text is `key:` or `key: value` rather than a plain scalar. */
function isMappingEntry(text: string): boolean {
  return splitKey(text) !== null;
}

/**
 * Split `key: value` at the FIRST unquoted colon that is followed by a space
 * or ends the line. `text_regex: "a:b"` therefore splits once, at the key.
 */
function splitKey(text: string): { key: string; rest: string } | null {
  if (text.startsWith("[") || text.startsWith("{")) return null;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch !== ":") continue;
    const after = text[i + 1];
    if (after !== undefined && after !== " ") continue;
    const key = text.slice(0, i).trim();
    if (key === "") return null;
    return { key: unquote(key), rest: text.slice(i + 1).trim() };
  }
  return null;
}

function parseMapping(
  lines: Line[],
  start: number,
  indent: number,
): [Record<string, unknown>, number] {
  const map: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlError("unexpected indentation in a mapping", line.number);
    }
    if (line.text.startsWith("- ")) break;
    const entry = splitKey(line.text);
    if (!entry) throw new YamlError(`expected "key: value"`, line.number);
    // A duplicate key is a silent overwrite in most YAML loaders; here it is
    // the difference between two assertions and one, so it fails.
    if (Object.hasOwn(map, entry.key)) {
      throw new YamlError(`duplicate key "${entry.key}"`, line.number);
    }
    if (entry.rest !== "") {
      map[entry.key] = parseScalar(entry.rest, line.number);
      i += 1;
      continue;
    }
    const next = lines[i + 1];
    if (!next || next.indent < indent) {
      throw new YamlError(`key "${entry.key}" has no value`, line.number);
    }
    // A block sequence may sit at the parent's own indent, which is legal
    // YAML and reads better for long assertion lists.
    const childIndent = next.indent === indent ? indent : next.indent;
    if (next.indent === indent && !next.text.startsWith("- ")) {
      throw new YamlError(`key "${entry.key}" has no value`, line.number);
    }
    const [value, after] = parseBlock(lines, i + 1, childIndent);
    map[entry.key] = value;
    i = after;
  }
  return [map, i];
}

// ---------------------------------------------------------------------------
// Scalars and flow collections
// ---------------------------------------------------------------------------

function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return JSON.parse(text) as string;
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text;
}

function parseScalar(text: string, line: number): unknown {
  if (text.startsWith("[")) return parseFlow(text, line, "]");
  if (text.startsWith("{")) return parseFlow(text, line, "}");
  if (text.startsWith('"') || text.startsWith("'")) {
    if (!/^(".*"|'.*')$/s.test(text)) {
      throw new YamlError("unterminated quoted scalar", line);
    }
    return unquote(text);
  }
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  // Underscored digits are a YAML 1.1 integer; the limits read better as
  // `1_800_000` than as an unbroken run of zeros.
  if (/^-?\d[\d_]*$/.test(text)) return Number(text.replaceAll("_", ""));
  if (/^-?\d[\d_]*\.\d+$/.test(text)) return Number(text.replaceAll("_", ""));
  return text;
}

/** A single-line flow collection whose members are scalars or nested flows. */
function parseFlow(text: string, line: number, close: "]" | "}"): unknown {
  if (!text.endsWith(close)) {
    throw new YamlError(`unterminated flow collection, expected "${close}"`, line);
  }
  const inner = text.slice(1, -1).trim();
  const isMap = close === "}";
  if (inner === "") return isMap ? {} : [];
  const parts = splitFlow(inner, line);
  if (!isMap) return parts.map((part) => parseScalar(part, line));
  const map: Record<string, unknown> = {};
  for (const part of parts) {
    const entry = splitKey(part);
    if (!entry) throw new YamlError(`expected "key: value" in a flow map`, line);
    if (Object.hasOwn(map, entry.key)) {
      throw new YamlError(`duplicate key "${entry.key}"`, line);
    }
    map[entry.key] = parseScalar(entry.rest, line);
  }
  return map;
}

/** Split on commas that are not inside quotes or a nested flow collection. */
function splitFlow(inner: string, line: number): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quote) throw new YamlError("unterminated quoted scalar", line);
  parts.push(inner.slice(start).trim());
  if (parts.some((part) => part === "")) {
    throw new YamlError("empty member in a flow collection", line);
  }
  return parts;
}
