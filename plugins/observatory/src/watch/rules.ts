// The seven stall rules. Pure: snapshot in, findings out, no clock and no
// database, so every rule test is a fixture and an assertion.
//
// The load-bearing idea is the EPISODE anchor. Each rule names the fact that
// makes this occurrence distinct — the item it went quiet after, the file
// change it has burned tokens since, the path it is oscillating on. The anchor
// becomes the dedupe key, so re-evaluating a still-true condition finds the
// same open row instead of a second one, and the arrival of a new item moves
// the anchor, which is what "re-arm" means mechanically. Nothing has to track
// episode numbers or remember what it fired last tick.
import type { RuleId, Severity } from "./contract.js";
import {
  PER_DAY_KEY,
  RULE_THRESHOLDS,
  type WatchConfig,
} from "./settings.js";
import type { ItemFact, WatchSnapshot } from "./queries.js";

export interface Finding {
  rule: RuleId;
  /** Distinguishes one occurrence from the next. See the note above. */
  episode: string;
  severity: Severity;
  /** One line naming the numbers. Shown as the inbox subtitle. */
  evidence: string;
  payload: Record<string, unknown>;
}

/** Items the last-20 window counts for the repeated-tool rule. */
const REPEAT_WINDOW = 20;
/** Item kinds the oscillation rule reads as read, edit and command. */
const READ_KIND = "fileRead";
const EDIT_KIND = "fileChange";
const COMMAND_KIND = "commandExecution";

const SEVERITY: Record<RuleId, Severity> = {
  "silence-no-inflight": "warn",
  "repeated-identical-tool": "warn",
  "read-edit-read": "warn",
  "active-no-turn": "warn",
  "burn-no-change": "warn",
  "retry-storm": "critical",
  "tree-budget": "critical",
};

/** Rules whose open signal means "this thread is stuck", for ranking and for
 * the `stalled` row state. Tree budget is a spend fact, not a stall. */
export const STALL_RULES: ReadonlySet<RuleId> = new Set<RuleId>([
  "silence-no-inflight",
  "repeated-identical-tool",
  "read-edit-read",
  "active-no-turn",
  "burn-no-change",
  "retry-storm",
]);

function threshold(config: WatchConfig, rule: RuleId): number {
  const { key, default: fallback } = RULE_THRESHOLDS[rule];
  return config.thresholds[key] ?? fallback;
}

function isActive(snapshot: WatchSnapshot): boolean {
  return snapshot.thread.status === "active";
}

function minutes(ms: number): string {
  return `${Math.floor(ms / 60_000)}m`;
}

/**
 * Every rule that fires for this thread, in rule-id order. A disabled rule is
 * skipped entirely rather than evaluated and filtered: a rule nobody wants
 * should cost nothing.
 */
export function evaluate(
  snapshot: WatchSnapshot,
  config: WatchConfig,
): Finding[] {
  const findings: Finding[] = [];
  const push = (finding: Finding | null): void => {
    if (finding) findings.push(finding);
  };
  const on = (rule: RuleId): boolean => config.enabled[rule] !== false;

  if (on("silence-no-inflight")) push(silenceNoInflight(snapshot, config));
  if (on("repeated-identical-tool")) push(repeatedTool(snapshot, config));
  if (on("read-edit-read")) push(readEditRead(snapshot, config));
  if (on("active-no-turn")) push(activeNoTurn(snapshot, config));
  if (on("burn-no-change")) push(burnNoChange(snapshot, config));
  if (on("retry-storm")) push(retryStorm(snapshot, config));
  if (on("tree-budget")) for (const f of treeBudget(snapshot, config)) push(f);

  return findings;
}

/** Active, nothing in flight, and nothing has happened for the threshold. */
function silenceNoInflight(
  snapshot: WatchSnapshot,
  config: WatchConfig,
): Finding | null {
  if (!isActive(snapshot) || snapshot.openItem !== null) return null;
  if (snapshot.lastEventAt === null) return null;
  const limit = threshold(config, "silence-no-inflight") * 60_000;
  const silentMs = snapshot.now - snapshot.lastEventAt;
  if (silentMs < limit) return null;
  const lastSeq = snapshot.items.at(-1)?.seq ?? null;
  return {
    rule: "silence-no-inflight",
    // The last item is the thing a new item replaces, so a new item ends this
    // episode and starts the silence clock over.
    episode: `item:${lastSeq ?? "none"}`,
    severity: SEVERITY["silence-no-inflight"],
    evidence: `silent ${minutes(silentMs)} with nothing in flight`,
    payload: { silentMs, lastItemSeq: lastSeq },
  };
}

/** The same tool arguments, over and over, inside the last 20 items. */
function repeatedTool(
  snapshot: WatchSnapshot,
  config: WatchConfig,
): Finding | null {
  const need = threshold(config, "repeated-identical-tool");
  const window = snapshot.items.slice(-REPEAT_WINDOW);
  const groups = new Map<string, ItemFact[]>();
  for (const item of window) {
    if (!item.fingerprint) continue;
    const group = groups.get(item.fingerprint);
    if (group) group.push(item);
    else groups.set(item.fingerprint, [item]);
  }
  let worst: { fingerprint: string; items: ItemFact[] } | null = null;
  for (const [fingerprint, items] of groups) {
    if (items.length < need) continue;
    if (!worst || items.length > worst.items.length) {
      worst = { fingerprint, items };
    }
  }
  if (!worst) return null;
  // The occurrence that CROSSED the threshold anchors the episode. It stops
  // moving as the run grows, so a lengthening loop stays one signal, and it
  // only changes once the run's head scrolls out of the window — by which
  // point this is genuinely a new loop.
  const anchor = worst.items[need - 1];
  const name = worst.items[0]?.name ?? "tool";
  return {
    rule: "repeated-identical-tool",
    episode: `${worst.fingerprint.slice(0, 12)}:${anchor?.seq ?? 0}`,
    severity: SEVERITY["repeated-identical-tool"],
    evidence: `${worst.items.length} of the last ${window.length} items repeat ${name} with identical input`,
    payload: {
      tool: name,
      repeats: worst.items.length,
      windowSize: window.length,
      fingerprint: worst.fingerprint.slice(0, 12),
    },
  };
}

/**
 * Read, edit, read the same path with no command in between: the shape of an
 * agent checking whether its own edit landed instead of running the thing.
 * A command between two path touches resets that path's run — the agent got
 * new information, so the next read is not the same flail.
 */
function readEditRead(
  snapshot: WatchSnapshot,
  config: WatchConfig,
): Finding | null {
  const need = threshold(config, "read-edit-read");
  const runs = new Map<string, { kinds: string[]; start: number }>();
  let best: { path: string; cycles: number; start: number } | null = null;

  for (const item of snapshot.items) {
    if (item.kind === COMMAND_KIND) {
      runs.clear();
      continue;
    }
    if (item.kind !== READ_KIND && item.kind !== EDIT_KIND) continue;
    if (!item.path) continue;
    const run = runs.get(item.path) ?? { kinds: [], start: item.seq };
    run.kinds.push(item.kind === READ_KIND ? "R" : "E");
    runs.set(item.path, run);

    const cycles = countCycles(run.kinds);
    if (cycles >= need && (!best || cycles > best.cycles)) {
      best = { path: item.path, cycles, start: run.start };
    }
  }
  if (!best) return null;
  return {
    rule: "read-edit-read",
    episode: `${best.path}:${best.start}`,
    severity: SEVERITY["read-edit-read"],
    evidence: `${best.cycles} read/edit/read cycles on ${best.path} with no command between`,
    payload: { path: best.path, cycles: best.cycles },
  };
}

/**
 * Count R-E-R triples that share their endpoints, so `R E R E R` is two
 * cycles, not one and not three. Anything else in the sequence (E E, R R)
 * simply does not advance the match.
 */
function countCycles(kinds: readonly string[]): number {
  let cycles = 0;
  let index = 0;
  while (index + 3 <= kinds.length) {
    if (
      kinds[index] === "R" &&
      kinds[index + 1] === "E" &&
      kinds[index + 2] === "R"
    ) {
      cycles += 1;
      // The trailing read opens the next cycle.
      index += 2;
    } else {
      index += 1;
    }
  }
  return cycles;
}

/** Active, but no turn has started for the threshold: the agent is not even
 * being asked to think. */
function activeNoTurn(
  snapshot: WatchSnapshot,
  config: WatchConfig,
): Finding | null {
  if (!isActive(snapshot) || snapshot.openTurn) return null;
  const limit = threshold(config, "active-no-turn") * 60_000;
  // Measured from when the last turn ENDED, not when it began. A forty-minute
  // turn that completed a second ago proves the agent is being asked to think;
  // measuring from its start would call that thread idle.
  const idleSince =
    snapshot.lastTurnCompletedAt ?? snapshot.lastTurnStartedAt;
  if (idleSince === null) return null;
  const since = snapshot.now - idleSince;
  if (since < limit) return null;
  return {
    rule: "active-no-turn",
    episode: `turn:${snapshot.lastTurnId ?? "none"}`,
    severity: SEVERITY["active-no-turn"],
    evidence: `active with no turn started for ${minutes(since)}`,
    payload: { sinceMs: since, lastTurnId: snapshot.lastTurnId },
  };
}

/** Tokens spent since the last file change. Thinking is not free. */
function burnNoChange(
  snapshot: WatchSnapshot,
  config: WatchConfig,
): Finding | null {
  const limit = threshold(config, "burn-no-change");
  if (snapshot.tokensSinceFileChange < limit) return null;
  return {
    rule: "burn-no-change",
    // A new fileChange moves the anchor AND resets the count, so the episode
    // both closes and cannot immediately reopen.
    episode: `fileChange:${snapshot.lastFileChangeSeq ?? "none"}`,
    severity: SEVERITY["burn-no-change"],
    evidence: `${Math.round(snapshot.tokensSinceFileChange / 1000)}k tokens since the last file change`,
    payload: {
      tokens: snapshot.tokensSinceFileChange,
      lastFileChangeSeq: snapshot.lastFileChangeSeq,
    },
  };
}

/** Retrying provider errors piling up inside the retry window. */
function retryStorm(
  snapshot: WatchSnapshot,
  config: WatchConfig,
): Finding | null {
  const need = threshold(config, "retry-storm");
  if (snapshot.retries.length < need) return null;
  const first = snapshot.retries[0];
  return {
    rule: "retry-storm",
    episode: `retry:${first?.turnId ?? "none"}`,
    severity: SEVERITY["retry-storm"],
    evidence: `${snapshot.retries.length} retrying provider errors in the last 10 minutes`,
    payload: {
      retries: snapshot.retries.length,
      firstTurnId: first?.turnId ?? null,
    },
  };
}

/**
 * Subtree or per-day spend over its ceiling. Two separate episodes: a tree
 * breach and a day breach are different facts with different owners, and
 * collapsing them would hide one behind the other.
 */
function treeBudget(
  snapshot: WatchSnapshot,
  config: WatchConfig,
): Finding[] {
  const findings: Finding[] = [];
  const perTree = threshold(config, "tree-budget");
  const perDay = config.thresholds[PER_DAY_KEY] ?? 500;

  if (snapshot.treeCostUsd > perTree) {
    // Subtree spend only ever grows, so anchoring on the root alone would fire
    // once and never re-arm. The doubling band re-anchors the episode at every
    // 2x of the ceiling: one signal per crossing, per the notification spec.
    const band = Math.floor(Math.log2(snapshot.treeCostUsd / perTree));
    findings.push({
      rule: "tree-budget",
      episode: `tree:${snapshot.thread.rootThreadId}:${band}`,
      severity: SEVERITY["tree-budget"],
      evidence: `subtree spend $${snapshot.treeCostUsd.toFixed(2)} over the $${perTree} ceiling`,
      payload: {
        scope: "tree",
        rootThreadId: snapshot.thread.rootThreadId,
        costUsd: snapshot.treeCostUsd,
        limitUsd: perTree,
      },
    });
  }
  if (snapshot.dayCostUsd > perDay) {
    const day = new Date(snapshot.now).toISOString().slice(0, 10);
    findings.push({
      rule: "tree-budget",
      episode: `day:${day}`,
      severity: SEVERITY["tree-budget"],
      evidence: `spend today $${snapshot.dayCostUsd.toFixed(2)} over the $${perDay} ceiling`,
      payload: {
        scope: "day",
        day,
        costUsd: snapshot.dayCostUsd,
        limitUsd: perDay,
      },
    });
  }
  return findings;
}

/** `<thread>:<rule>:<episode>` — one episode, one row, forever. */
export function dedupeKey(threadId: string, finding: Finding): string {
  return `${threadId}:${finding.rule}:${finding.episode}`;
}
