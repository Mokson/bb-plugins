// The post-compaction premise reminder.
//
// A compaction throws away the conversation that held the run's premise: what
// "done" means, and which decisions are still open. The agent then rediscovers
// both, badly, over several turns. This sends it back once, as a QUEUED
// message rather than a steer, because it is context for the next turn and not
// an interruption of this one.
//
// Off by default (PRODUCT invariant 24). Exactly one message per compaction,
// enforced by a durable watermark rather than an in-memory set: a plugin
// reload must not re-send a reminder the thread already has.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Heading whose rows say what finishing means. Matched case-insensitively. */
const DONE_WHEN = "done-when";
/** Heading whose unresolved rows are the decisions still in the air. */
const DECISIONS = "decisions";
/** Rows quoted per section. A reminder longer than this is a second problem. */
const MAX_ROWS = 12;

/** `<runFolder>/LEDGER.md`, or null when it is missing or unreadable. */
export function readLedger(runFolder: string): string | null {
  try {
    return readFileSync(join(runFolder, "LEDGER.md"), "utf8");
  } catch {
    // An absent ledger is an ordinary state — the run folder was resolved by
    // recency and the file may since have been moved — not an error worth a
    // log line every compaction.
    return null;
  }
}

/**
 * The rows under one `##` heading, up to the next heading of any level.
 *
 * Matched on the heading's leading word so `## Done-when`, `## done-when` and
 * `## Done-when (acceptance)` all resolve, which is how the three ledgers in
 * this repo's history have actually been written.
 */
export function section(markdown: string, heading: string): string[] {
  const lines = markdown.split("\n");
  const rows: string[] = [];
  let inside = false;
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      if (inside) break;
      inside =
        match[1] === "##" &&
        (match[2] ?? "").trim().toLowerCase().startsWith(heading);
      continue;
    }
    if (!inside) continue;
    const trimmed = line.trim();
    if (trimmed.length > 0) rows.push(trimmed);
  }
  return rows;
}

/**
 * A decision row still in the air.
 *
 * A ticked checkbox is decided. So is a row whose first word is a resolution
 * marker, because half the ledgers in this repo record decisions as prose
 * rather than as checkboxes and the reminder must not quote settled ones back.
 */
export function isOpenDecision(row: string): boolean {
  if (/^[-*]\s*\[[xX]\]/.test(row)) return false;
  return !/^[-*]?\s*\**\s*(decided|resolved|settled|closed)\b/i.test(row);
}

/**
 * The reminder text, or null when the ledger has nothing to say. Null is a
 * real answer: a run with no done-when and no open decision does not need a
 * message, and sending an empty one would spend a turn on nothing.
 */
export function buildPremiseReminder(
  runFolder: string,
  ledger: string,
): string | null {
  const doneWhen = section(ledger, DONE_WHEN).slice(0, MAX_ROWS);
  const decisions = section(ledger, DECISIONS)
    .filter(isOpenDecision)
    .slice(0, MAX_ROWS);
  if (doneWhen.length === 0 && decisions.length === 0) return null;

  const lines = [
    "[observatory] This thread just compacted, so the run's premise may have",
    `gone with it. From ${join(runFolder, "LEDGER.md")}:`,
    "",
  ];
  if (doneWhen.length > 0) {
    lines.push("done-when:", ...doneWhen, "");
  }
  if (decisions.length > 0) {
    lines.push("open decisions:", ...decisions, "");
  }
  lines.push(
    "Re-read the ledger yourself if you need more than this; these rows are a",
    "reminder, not the spec.",
  );
  return lines.join("\n");
}
