/**
 * Slash-command skills, read from the provider session log.
 *
 * A skill invoked as `/pr` leaves no BB thread event at all: BB records the
 * `Skill` tool call, and nothing else. The Claude Code session log is the only
 * place the command survives, as a `user` entry carrying
 * `<command-name>/pr</command-name>`.
 *
 * A `<command-name>` on its own is not proof of a skill - `/clear` and
 * `/config` are built-in CLI commands. The proof is the entry that follows it,
 * which carries `Base directory for this skill: <path>` and names the skill
 * that the command loaded.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillInvocation } from "./model";

const COMMAND_NAME = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const SKILL_DIRECTORY = /Base directory for this skill:\s*(\S+)/;

/** Longest `<command-args>` value kept, so a pasted essay cannot bloat a row. */
const MAX_ARGS = 2000;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Entry text, whether the provider wrote a string or content blocks. */
function entryText(entry: Record<string, unknown>): string {
  const content = asRecord(entry["message"])["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const text = asRecord(block)["text"];
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

/** Last path segment of a skill directory, which is the skill's name. */
function skillNameFromPath(path: string): string | null {
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  return last === undefined || last.length === 0 ? null : last;
}

/**
 * Slash-command skill invocations in one session log.
 *
 * Pairing rule: each `<command-name>` entry claims the next skill directory
 * announced before the following `<command-name>`. A command with no skill
 * directory after it was a built-in CLI command and is dropped. A skill
 * directory with no command before it came from a `Skill` tool call, which BB
 * already records as an event, so it is dropped too.
 */
export function parseCommandInvocations(
  lines: Iterable<string>,
  threadId: string,
): SkillInvocation[] {
  const invocations: SkillInvocation[] = [];
  let pending: { itemId: string; createdAt: number; args: string | null } | null = null;

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let entry: Record<string, unknown>;
    try {
      entry = asRecord(JSON.parse(line));
    } catch {
      // A truncated final line is normal while the agent is still writing.
      continue;
    }
    if (entry["type"] !== "user") continue;
    const text = entryText(entry);

    const command = COMMAND_NAME.exec(text);
    if (command !== null) {
      const uuid = entry["uuid"];
      const timestamp = entry["timestamp"];
      if (typeof uuid !== "string" || uuid.length === 0) continue;
      const args = COMMAND_ARGS.exec(text);
      const trimmed = args?.[1]?.trim() ?? "";
      pending = {
        itemId: uuid,
        createdAt: typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN,
        args: trimmed.length === 0 ? null : trimmed.slice(0, MAX_ARGS),
      };
      continue;
    }

    if (pending === null) continue;
    const directory = SKILL_DIRECTORY.exec(text);
    if (directory === null) continue;
    const skill = skillNameFromPath(directory[1] ?? "");
    if (skill !== null) {
      invocations.push({
        itemId: pending.itemId,
        threadId,
        // Session-log entries carry no BB event sequence; ordering is by time.
        seq: 0,
        createdAt: Number.isFinite(pending.createdAt) ? pending.createdAt : 0,
        skill,
        args: pending.args,
        // The log records that the skill loaded. There is no separate outcome
        // to read, unlike a tool call with its own status.
        status: "completed",
        result: null,
        source: "command",
      });
    }
    pending = null;
  }
  return invocations;
}

/** Root holding Claude Code session logs, one directory per workspace. */
export function sessionProjectsRoot(): string {
  const configured = process.env["CLAUDE_CONFIG_DIR"];
  const base = configured !== undefined && configured.length > 0 ? configured : join(homedir(), ".claude");
  return join(base, "projects");
}

export interface SessionFile {
  path: string;
  mtimeMs: number;
  sizeBytes: number;
}

/**
 * Session log files for the given provider thread ids. The file is named after
 * the provider thread id, but its directory is a slug of the workspace path,
 * so each candidate directory is probed rather than the slug recomputed.
 */
export async function findSessionFiles(
  providerThreadIds: ReadonlySet<string>,
  root: string,
): Promise<SessionFile[]> {
  if (providerThreadIds.size === 0) return [];
  let directories: string[];
  try {
    directories = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No local Claude Code logs on this machine, which is not an error: the
    // thread may run on another provider or another host.
    return [];
  }

  const found: SessionFile[] = [];
  for (const id of providerThreadIds) {
    for (const directory of directories) {
      const path = join(root, directory, `${id}.jsonl`);
      try {
        const stats = await stat(path);
        if (!stats.isFile()) continue;
        found.push({ path, mtimeMs: stats.mtimeMs, sizeBytes: stats.size });
        break;
      } catch {
        continue;
      }
    }
  }
  return found;
}

/** Read and parse one session log. An unreadable file yields nothing. */
export async function readCommandInvocations(
  path: string,
  threadId: string,
): Promise<SkillInvocation[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    return [];
  }
  return parseCommandInvocations(content.split("\n"), threadId);
}
