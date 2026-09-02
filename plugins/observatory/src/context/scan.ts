// What every request in a project pays for before the first user word.
//
// The scan walks four surfaces and returns one block per thing that occupies
// the prefix. It reads only what is billed: a skill costs its frontmatter
// `name` and `description` on every request, not its body, so only those two
// are measured. An MCP server costs its name and its tool schemas; its
// `args` and `env` are neither billed nor ours to read, so this file never
// touches those keys — that is the module's hardest invariant, because the
// config it opens is the one file on the machine most likely to hold a token.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ContextSurface } from "./contract.js";

/** One measured occupant of the prefix, before duplicate and dead analysis. */
export interface ScannedBlock {
  surface: ContextSurface;
  path: string | null;
  name: string;
  /** The billed text. Shingles and the token estimate both read this. */
  text: string;
}

export interface PluginToolDescriptor {
  name: string;
  description: string;
}

export interface ScanInput {
  cwd: string;
  /** Overridable so a test can point the global surfaces at a fixture. */
  home?: string;
  pluginTools?: readonly PluginToolDescriptor[];
}

/** An `@import` chain deeper than this is a cycle or a mistake; either way it
 *  is not something to follow forever. */
const IMPORT_DEPTH_CAP = 5;

/** `@./path`, `@~/path` or `@path` on its own line, the CLAUDE.md import. */
const IMPORT_LINE = /^\s*@([^\s`]+)\s*$/u;

/** A prefix file this large is a data dump, not instructions. Reading it would
 *  cost more than the answer is worth, so the scan notes it and moves on. */
export const MAX_INSTRUCTION_BYTES = 1_048_576;

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // A surface that is not there is the common case, not an error: nobody
    // has all four providers' config files.
    return null;
  }
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function expandHome(path: string, home: string): string {
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/**
 * Follow one instruction file and every file it imports, depth-first, each
 * file emitted once. A file already seen is dropped rather than re-billed:
 * two surfaces importing the same rules file pay for it once.
 */
function collectInstruction(
  path: string,
  home: string,
  seen: Set<string>,
  out: ScannedBlock[],
  depth = 0,
): void {
  const absolute = resolve(path);
  if (seen.has(absolute) || depth > IMPORT_DEPTH_CAP) return;
  const size = sizeOf(absolute);
  if (size !== null && size > MAX_INSTRUCTION_BYTES) {
    // Recorded as a block rather than dropped: an unread file is a hole in the
    // composition bar, and a hole nobody is told about reads as a zero.
    seen.add(absolute);
    out.push({
      surface: "instruction",
      path: absolute,
      name: absolute,
      text: `(not scanned: ${size} bytes exceeds the ${MAX_INSTRUCTION_BYTES} byte cap)`,
    });
    return;
  }
  const text = readText(absolute);
  if (text === null) return;
  seen.add(absolute);
  out.push({ surface: "instruction", path: absolute, name: absolute, text });
  for (const line of text.split("\n")) {
    const match = IMPORT_LINE.exec(line);
    if (!match) continue;
    const target = expandHome(match[1] as string, home);
    collectInstruction(
      isAbsolute(target) ? target : join(dirname(absolute), target),
      home,
      seen,
      out,
      depth + 1,
    );
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/u;

/**
 * The two frontmatter keys a mounted skill charges for. Parsed rather than
 * YAML-loaded: the fields are one line each by convention, and a dependency
 * for two keys is a dependency to keep current forever.
 */
export function parseSkillFrontmatter(
  markdown: string,
): { name: string; description: string } | null {
  const block = FRONTMATTER.exec(markdown);
  if (!block) return null;
  const fields: Record<string, string> = {};
  for (const line of (block[1] as string).split("\n")) {
    const match = /^([A-Za-z_-]+):\s*(.*)$/u.exec(line);
    if (!match) continue;
    const value = (match[2] as string).trim();
    fields[match[1] as string] = value.replace(/^["']|["']$/gu, "");
  }
  const name = fields["name"];
  const description = fields["description"];
  if (!name) return null;
  return { name, description: description ?? "" };
}

/**
 * Every skill under one root, each skill counted once.
 *
 * Roots overlap by design on this machine: `~/.claude/skills` is commonly a
 * symlink to `~/.agents/skills`, and a skill reached through both paths is one
 * mounted skill billed once, so identity is the resolved realpath.
 */
function collectSkills(
  root: string,
  seen: Set<string>,
  out: ScannedBlock[],
): void {
  for (const entry of listDir(root)) {
    const dir = join(root, entry);
    if (!isDirectory(dir)) continue;
    const path = join(dir, "SKILL.md");
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    const text = readText(path);
    if (text === null) continue;
    const parsed = parseSkillFrontmatter(text);
    if (!parsed) continue;
    out.push({
      surface: "skill",
      path,
      name: parsed.name,
      // Name and description only: the body is loaded on demand, so billing
      // the whole file would overstate every skill by an order of magnitude.
      text: `${parsed.name}: ${parsed.description}`,
    });
  }
}

/**
 * Server names and tool counts from an MCP config, and nothing else.
 *
 * The function reads `mcpServers` keys and, when a server declares its tools
 * inline, their names. `command`, `args`, `env`, `headers` and `url` are never
 * read: they carry credentials, and the prefix cost of a server is its tool
 * schemas, not how it is launched.
 */
export function mcpBlocksFromConfig(
  json: string,
  path: string,
): ScannedBlock[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const root = parsed as { mcpServers?: Record<string, unknown> } | null;
  const servers = root?.mcpServers;
  if (!servers || typeof servers !== "object") return [];
  const blocks: ScannedBlock[] = [];
  for (const name of Object.keys(servers).sort()) {
    const entry = servers[name] as { tools?: unknown } | null;
    const tools = Array.isArray(entry?.tools) ? entry.tools : [];
    const toolNames = tools
      .map((tool) =>
        typeof tool === "string"
          ? tool
          : typeof (tool as { name?: unknown }).name === "string"
            ? ((tool as { name: string }).name)
            : null,
      )
      .filter((tool): tool is string => tool !== null);
    blocks.push({
      surface: "mcp",
      path,
      name,
      text: `${name} (${toolNames.length} tools)${
        toolNames.length ? `: ${toolNames.join(", ")}` : ""
      }`,
    });
  }
  return blocks;
}

/**
 * Every block the prefix of a request in `cwd` carries, in surface order.
 */
export function scanSurfaces(input: ScanInput): ScannedBlock[] {
  const home = input.home ?? homedir();
  const cwd = resolve(input.cwd);
  const blocks: ScannedBlock[] = [];
  const seen = new Set<string>();

  for (const candidate of [
    join(cwd, "AGENTS.md"),
    join(cwd, "CLAUDE.md"),
    join(cwd, ".claude", "CLAUDE.md"),
    join(home, ".agents", "AGENTS.md"),
    join(home, ".claude", "CLAUDE.md"),
  ]) {
    collectInstruction(candidate, home, seen, blocks);
  }
  const rules = join(cwd, ".claude", "rules");
  for (const entry of listDir(rules)) {
    collectInstruction(join(rules, entry), home, seen, blocks);
  }

  const skillsSeen = new Set<string>();
  for (const root of [
    join(home, ".agents", "skills"),
    join(home, ".claude", "skills"),
    join(cwd, ".claude", "skills"),
    join(cwd, ".agents", "skills"),
  ]) {
    collectSkills(root, skillsSeen, blocks);
  }

  for (const path of [join(home, ".claude.json"), join(cwd, ".mcp.json")]) {
    const json = readText(path);
    if (json !== null) blocks.push(...mcpBlocksFromConfig(json, path));
  }

  for (const tool of input.pluginTools ?? []) {
    blocks.push({
      surface: "plugin-tool",
      path: null,
      name: tool.name,
      text: `${tool.name}: ${tool.description}`,
    });
  }
  return blocks;
}

/** Stable identity of a block's billed text, for change detection. */
export function blockHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
