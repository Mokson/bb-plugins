// `COST.md` for one deliver run folder.
//
// This file has one consumer with one requirement: the retro seat parses it
// without editing it. So the shape is a contract, not a rendering choice —
// seven header keys in a fixed order, one blank line, one eight-column table
// sorted by cost descending, `n/a` for anything unmatched, and a CLOSED flag
// vocabulary. A flag nobody defined is a flag the retro seat silently drops.
//
// Two header keys are load-bearing and used to contradict each other.
// `tokens_total` is input + output + reasoning and EXCLUDES cache reads and
// writes, matching the retro schema's "a token count is not a cost, since
// cache reads dominate the bill and never appear in the ledger's token
// column". `cache_read_tokens` reports the reads the run could prove, with a
// `+` suffix when some selected turn could not - a floor, not a total - and
// `n/a` only when no turn in the run has a proven split. The earlier shape
// counted those reads inside `tokens_total` while printing `n/a` beside them,
// so the two keys the retro seat consumes stated opposite things.
//
// `cache_read_share` is that read count over ALL tokens processed
// (`tokens_total` plus the proven reads), since the reads are no longer part
// of the denominator.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { markdownCell } from "./rollup.js";

/** Every flag `COST.md` may carry. Nothing outside this set is emitted. */
export const COST_MD_FLAGS = [
  "mismatch",
  "nested",
  "tier-policy",
  "high-turns",
] as const;

export type CostMdFlag = (typeof COST_MD_FLAGS)[number];

export type Snapshot = "final" | "mid-run";

/** Share of a run's threads whose turn count makes them an outlier. */
const HIGH_TURNS_PERCENTILE = 0.9;

export interface CostMdOptions {
  runFolder: string;
  snapshot?: Snapshot;
  now?: () => number;
  /** Injected for tests; defaults to reading `<runFolder>/LEDGER.md`. */
  readLedger?: (runFolder: string) => string | null;
}

interface AgentRow {
  thread_id: string;
  title: string | null;
  seat: string | null;
  tier_tag: string | null;
  depth: number;
  status: string | null;
  turns: number;
  model: string | null;
  requested: string | null;
  effort: string | null;
  tool_uses: number | null;
  duration_ms: number | null;
  cost_usd: number | null;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read: number | null;
  read_nulls: number;
}

/**
 * The selection: every thread attributed to this run folder, plus their
 * descendants. A seat's subagents are part of the run's bill even though
 * nothing wrote the run folder onto them.
 */
const SELECT_AGENTS = `
WITH RECURSIVE picked(thread_id) AS (
  SELECT thread_id FROM obs_thread WHERE run_folder = @folder
  UNION
  SELECT th.thread_id FROM obs_thread th
    JOIN picked p ON th.parent_thread_id = p.thread_id
)
SELECT th.thread_id, th.title, th.seat, th.tier_tag,
       COALESCE(th.depth, 0) AS depth, th.status,
       COUNT(t.turn_id) AS turns,
       -- The MODAL value, not MAX: a seat that ran one turn elsewhere is a
       -- mismatch flag, and letting that one turn win the model column would
       -- also fire tier-policy against a tier the seat actually honored.
       (SELECT x.model_reported FROM obs_turn x
         WHERE x.thread_id = th.thread_id AND x.model_reported IS NOT NULL
         GROUP BY x.model_reported
         ORDER BY COUNT(*) DESC, x.model_reported LIMIT 1) AS model,
       (SELECT x.model_requested FROM obs_turn x
         WHERE x.thread_id = th.thread_id AND x.model_requested IS NOT NULL
         GROUP BY x.model_requested
         ORDER BY COUNT(*) DESC, x.model_requested LIMIT 1) AS requested,
       (SELECT x.effort FROM obs_turn x
         WHERE x.thread_id = th.thread_id AND x.effort IS NOT NULL
         GROUP BY x.effort
         ORDER BY COUNT(*) DESC, x.effort LIMIT 1) AS effort,
       SUM(t.tool_calls) AS tool_uses,
       SUM(t.duration_ms) AS duration_ms,
       SUM(t.cost_usd) AS cost_usd,
       COALESCE(SUM(t.input_tokens), 0) AS input_tokens,
       COALESCE(SUM(t.output_tokens), 0) AS output_tokens,
       COALESCE(SUM(t.reasoning_tokens), 0) AS reasoning_tokens,
       COALESCE(SUM(t.cache_read_tokens), 0) AS cache_read,
       SUM(CASE WHEN t.cache_read_tokens IS NULL THEN 1 ELSE 0 END) AS read_nulls,
       SUM(CASE WHEN t.model_requested IS NOT NULL
                 AND t.model_reported IS NOT NULL
                 AND t.model_requested <> t.model_reported
                THEN 1 ELSE 0 END) AS mismatches
  FROM picked p
  JOIN obs_thread th ON th.thread_id = p.thread_id
  LEFT JOIN obs_turn t ON t.thread_id = th.thread_id
 GROUP BY th.thread_id
`;

/** The delegate table: which model families each tier tag admits. */
const TIER_FAMILIES: ReadonlyArray<{ match: RegExp; family: string }> = [
  { match: /hai/iu, family: "haiku" },
  { match: /son/iu, family: "sonnet" },
  { match: /opus|^opu/iu, family: "opus" },
  { match: /fable|^fab/iu, family: "fable" },
];

function familyOf(value: string | null): string | null {
  if (!value) return null;
  return TIER_FAMILIES.find((entry) => entry.match.test(value))?.family ?? null;
}

/**
 * `tier-policy` fires when the tier tag names a model family and the model the
 * provider actually reported belongs to a different one: the delegate table
 * routes mechanical work to haiku, defined and complex work to sonnet or opus,
 * and judgment to fable, and a seat that silently ran elsewhere is the whole
 * reason the flag exists.
 */
export function tierPolicyViolated(
  tierTag: string | null,
  modelReported: string | null,
): boolean {
  const declared = familyOf(tierTag?.split(":")[0] ?? null);
  const actual = familyOf(modelReported);
  return declared !== null && actual !== null && declared !== actual;
}

/**
 * One table cell. The eight-column contract is parsed by position, so a pipe
 * or a newline inside an agent name or a model id would hand the retro seat a
 * row of the wrong width; both are neutralised rather than dropped, because
 * the value still has to read back as what it was.
 */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  const text = typeof value === "number" ? String(value) : value.trim();
  return text === "" ? "n/a" : markdownCell(text);
}

/**
 * Fields per bullet runlog row before it is believed to be one. Real rows run
 * to a dozen columns; a two-field bullet is prose that happens to hold a pipe.
 */
const BULLET_ROW_MIN_FIELDS = 4;
/** A stage name: one short lowercase word, which is what the seats write. */
const STAGE_TOKEN = /^[a-z][a-z-]{1,19}$/u;

/**
 * Parse the run's LEDGER.md for a stage per row.
 *
 * Two runlog shapes exist in the corpus and both are read here, because a
 * stage column that is `n/a` for every row of every real run is a column
 * nobody can use:
 *
 *   a markdown table with a `stage` header cell, and
 *   `- <stage> | <field> | <field> | ...` bullet rows, where the stage leads.
 *
 * In both, every OTHER field becomes a lookup key, so a runlog keyed by run id
 * and one keyed by seat name resolve without a second parser.
 */
export function parseLedgerStages(markdown: string | null): Map<string, string> {
  const stages = new Map<string, string>();
  if (!markdown) return stages;
  const cells = (line: string) =>
    line
      .trim()
      .replace(/^\|/u, "")
      .replace(/\|$/u, "")
      .split("|")
      .map((part) => part.trim());
  const lines = markdown.split("\n");
  let header: string[] | null = null;
  let stageIndex = -1;
  /** Record `stage` against every other field of one parsed row. */
  const record = (row: readonly string[], stage: string, skip: number) => {
    if (!stage || stage === "n/a") return;
    row.forEach((value, index) => {
      const key = value.trim().toLowerCase();
      if (index === skip || key === "" || key === "n/a") return;
      if (!stages.has(key)) stages.set(key, stage);
    });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      header = null;
      // The bullet runlog shape: the stage leads, the rest are lookup keys.
      if (trimmed.startsWith("- ") && trimmed.includes("|")) {
        const fields = cells(trimmed.slice(2));
        const stage = fields[0]?.toLowerCase() ?? "";
        if (fields.length >= BULLET_ROW_MIN_FIELDS && STAGE_TOKEN.test(stage)) {
          record(fields, stage, 0);
        }
      }
      continue;
    }
    const row = cells(line);
    if (header === null) {
      header = row.map((name) => name.toLowerCase());
      stageIndex = header.indexOf("stage");
      continue;
    }
    // The `| --- |` separator under the header.
    if (row.every((part) => /^:?-{2,}:?$/u.test(part))) continue;
    if (stageIndex === -1) continue;
    record(row, row[stageIndex]?.trim() ?? "", stageIndex);
  }
  return stages;
}

function stageFor(
  stages: Map<string, string>,
  row: AgentRow,
  agent: string,
): string | null {
  const direct =
    stages.get(row.thread_id.toLowerCase()) ??
    stages.get(agent.toLowerCase()) ??
    (row.seat ? stages.get(row.seat.toLowerCase()) : undefined);
  if (direct) return direct;
  const title = (row.title ?? "").toLowerCase();
  if (title === "") return null;
  for (const [key, stage] of stages) {
    if (key.length >= 3 && title.includes(key)) return stage;
  }
  return null;
}

/** The 90th percentile of turn counts across the run, nearest-rank. */
export function highTurnsThreshold(turnCounts: readonly number[]): number {
  if (turnCounts.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...turnCounts].sort((a, b) => a - b);
  const rank = Math.ceil(HIGH_TURNS_PERCENTILE * sorted.length) - 1;
  return sorted[Math.max(0, rank)] as number;
}

export interface CostMdResult {
  content: string;
  filename: string;
  agents: number;
  snapshot: Snapshot;
}

export function buildCostMd(
  db: Database,
  options: CostMdOptions,
): CostMdResult {
  const now = (options.now ?? Date.now)();
  const rows = db
    .prepare<Record<string, string>, AgentRow & { mismatches: number }>(
      SELECT_AGENTS,
    )
    .all({ folder: options.runFolder });

  const readLedger =
    options.readLedger ??
    ((folder: string) => {
      try {
        return readFileSync(join(folder, "LEDGER.md"), "utf8");
      } catch {
        // A run folder without a ledger is a fact, not a failure: the stage
        // column simply reads n/a for every row.
        return null;
      }
    });
  const stages = parseLedgerStages(readLedger(options.runFolder));

  const active = rows.some(
    (row) => row.status === "active" || row.status === "running",
  );
  const snapshot: Snapshot = options.snapshot ?? (active ? "mid-run" : "final");
  const threshold = highTurnsThreshold(
    rows.filter((row) => row.turns > 0).map((row) => row.turns),
  );

  let costTotal = 0;
  let tokensTotal = 0;
  let cacheRead = 0;
  let readsProven = 0;
  let splitUnproven = false;

  const table = rows
    .map((row) => {
      const agent = row.seat ?? row.title ?? row.thread_id;
      const flags: CostMdFlag[] = [];
      if (row.mismatches > 0) flags.push("mismatch");
      if (row.depth > 1) flags.push("nested");
      if (tierPolicyViolated(row.tier_tag, row.model)) flags.push("tier-policy");
      if (row.turns > threshold) flags.push("high-turns");

      costTotal += row.cost_usd ?? 0;
      tokensTotal +=
        row.input_tokens + row.output_tokens + row.reasoning_tokens;
      cacheRead += row.cache_read ?? 0;
      readsProven += Math.max(0, row.turns - row.read_nulls);
      if (row.read_nulls > 0) splitUnproven = true;

      return {
        cost: row.cost_usd,
        cells: [
          cell(agent),
          cell(row.model),
          cell(row.effort),
          cell(stageFor(stages, row, agent)),
          cell(row.tool_uses),
          cell(
            row.duration_ms === null
              ? null
              : Math.round(row.duration_ms / 1_000),
          ),
          cell(row.cost_usd === null ? null : row.cost_usd.toFixed(4)),
          flags.length === 0 ? "n/a" : flags.join(" "),
        ],
      };
    })
    .sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1))
    .map((entry) => `| ${entry.cells.join(" | ")} |`);

  // `+` marks a floor: at least one selected turn has no proven split, so the
  // real figure is higher than the one printed.
  const suffix = splitUnproven ? "+" : "";
  const processed = tokensTotal + cacheRead;
  const share =
    readsProven === 0 || processed === 0
      ? "n/a"
      : `${((cacheRead / processed) * 100).toFixed(1)}%${suffix}`;

  const content = [
    `snapshot: ${snapshot}`,
    `generated_at: ${new Date(now).toISOString()}`,
    `agents: ${rows.length}`,
    `cost_usd_total: ${costTotal.toFixed(4)}`,
    `tokens_total: ${tokensTotal}`,
    `cache_read_tokens: ${readsProven === 0 ? "n/a" : `${cacheRead}${suffix}`}`,
    `cache_read_share: ${share}`,
    "",
    "| agent | model | effort | stage | tool uses | duration s | cost usd | flags |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...table,
    "",
  ].join("\n");

  return {
    content,
    filename: join(options.runFolder, "COST.md"),
    agents: rows.length,
    snapshot,
  };
}
