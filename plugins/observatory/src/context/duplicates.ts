// Two ways a prefix wastes money: saying the same thing twice, and mounting a
// skill nothing ever calls.
//
// Duplicates are found by 8-word shingles rather than by diffing. The same
// rule reworded across CLAUDE.md and a skill shares almost no lines but shares
// most of its phrases, and phrases are what the model pays for either way.
import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import type { ContextDuplicate } from "./contract.js";

/** Words per shingle. Long enough that a shared sentence is signal, short
 *  enough that a reworded one still overlaps. */
export const SHINGLE_WORDS = 8;

/** Overlap above this is worth a person's attention; below it is English. */
export const DUPLICATE_THRESHOLD = 0.3;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, " ")
    .split(/\s+/u)
    .filter((word) => word.length > 0);
}

export function shingles(text: string): Set<string> {
  const tokens = words(text);
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length < SHINGLE_WORDS) {
    out.add(hash(tokens.join(" ")));
    return out;
  }
  for (let index = 0; index + SHINGLE_WORDS <= tokens.length; index += 1) {
    out.add(hash(tokens.slice(index, index + SHINGLE_WORDS).join(" ")));
  }
  return out;
}

function hash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

/**
 * Shared shingles over the SMALLER block's shingles.
 *
 * Dividing by the smaller side is what makes the ratio symmetric, and it is
 * also the honest question: a short rule wholly contained in a long file is
 * fully duplicated, however little of the long file it covers.
 */
export function overlapRatio(a: Set<string>, b: Set<string>): number {
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  if (smaller.size === 0) return 0;
  let shared = 0;
  for (const value of smaller) if (larger.has(value)) shared += 1;
  return shared / smaller.size;
}

export interface DuplicateCandidate {
  name: string;
  text: string;
  estTokens: number;
}

/**
 * Every unordered pair over the threshold, once, sorted by what it would give
 * back. A block is never compared with itself: an identical block is the same
 * block, not a duplicate of it.
 */
export function findDuplicates(
  blocks: readonly DuplicateCandidate[],
): ContextDuplicate[] {
  const sets = blocks.map((block) => shingles(block.text));
  const out: ContextDuplicate[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      const a = blocks[i] as DuplicateCandidate;
      const b = blocks[j] as DuplicateCandidate;
      const overlap = overlapRatio(
        sets[i] as Set<string>,
        sets[j] as Set<string>,
      );
      if (overlap <= DUPLICATE_THRESHOLD) continue;
      // Deleting the pair's smaller side is the only recovery that is
      // actually available, so that is what is offered.
      const recoverableTokens = Math.round(
        Math.min(a.estTokens, b.estTokens) * overlap,
      );
      out.push({ a: a.name, b: b.name, overlap, recoverableTokens });
    }
  }
  return out.sort((x, y) => y.recoverableTokens - x.recoverableTokens);
}

function parseNames(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return value.split(",").map((entry) => entry.trim());
  }
}

/**
 * Every skill name any indexed session used, lower-cased.
 *
 * Two sources, because two providers record it differently: the ledger's own
 * `Skill` items, and the skill names the log parsers lifted off provider
 * transcripts. One mention in either is enough to prove a skill is alive.
 */
export function usedSkillNames(
  db: Database,
  sinceIso: string,
  sinceMs: number,
): Set<string> {
  const used = new Set<string>();
  const items = db
    .prepare<[string], { name: string | null }>(
      `SELECT DISTINCT name FROM obs_item
        WHERE name IS NOT NULL
          AND (kind = 'Skill' OR name = 'Skill' OR kind = 'skill')
          AND COALESCE(completed_at, started_at, '') >= ?`,
    )
    .all(sinceIso);
  for (const row of items) if (row.name) used.add(row.name.toLowerCase());
  const logged = db
    .prepare<[number], { skill_names: string | null }>(
      `SELECT DISTINCT skill_names FROM obs_log_turn
        WHERE skill_names IS NOT NULL AND ts >= ?`,
    )
    .all(sinceMs);
  for (const row of logged) {
    for (const name of parseNames(row.skill_names)) {
      used.add(name.toLowerCase());
    }
  }
  return used;
}
