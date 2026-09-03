// One run, measured against what a normal run looks like.
//
// Every number here already exists in the ledger; what audit adds is the
// comparison. A session costing four dollars means nothing on its own and
// means a great deal beside a 7-day median of one, so each metric is reported
// with its median and the relative gap, and nothing is reported without one.
//
// The 7-day median rather than the mean: one runaway run would drag a mean far
// enough that the next runaway looks ordinary.
import { realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Database } from "better-sqlite3";
import type { ObservatoryStore } from "../core/store.js";
import type { SpendRange } from "../spend/contract.js";
import { rangeStart } from "../spend/rollup.js";
import { buildCostMd } from "../spend/cost-md.js";
import { median } from "../context/estimate.js";
import type {
  AuditFinding,
  AuditMetric,
  AuditSessionRow,
  AuditSessionView,
  AuditUnverifiedEdit,
  AuditVerification,
} from "./contract.js";
import { failureRows } from "./failures.js";
import { auditInsights } from "./insights.js";

export interface AuditDeps {
  db: Database;
  store: ObservatoryStore;
  now?(): Date;
}

export interface AuditTarget {
  threadId?: string | undefined;
  runFolder?: string | undefined;
}

/** Item kinds that run something rather than reading or writing a file. */
const COMMAND_KINDS = ["commandExecution", "toolCall"];

/**
 * What a verification command looks like in the one field the ledger keeps.
 *
 * Core fingerprints command arguments and drops the text, so the only place a
 * pattern can match is the item's name or path. When nothing matches anywhere
 * in the thread the detector says so through `textAvailable: false` and falls
 * back to treating any command as the verification boundary, which is the
 * weaker claim and is reported as the weaker claim.
 */
export const VERIFICATION_PATTERN =
  /\b(test|tests|lint|typecheck|type-check|tsc|build|vitest|jest|pytest|eslint|check)\b/iu;

const METRIC_KEYS = [
  "turns",
  "toolCalls",
  "tokens",
  "costUsd",
  "wallMs",
  "providerErrors",
  "compactions",
] as const;

type MetricKey = (typeof METRIC_KEYS)[number];

// The thread filter belongs in WHERE, not HAVING: filtering after the group by
// makes SQLite aggregate every session in range to keep one.
const SESSION_ROWS_HEAD = `
  SELECT th.thread_id AS threadId, th.title AS title, th.seat AS seat,
         th.run_folder AS runFolder,
         COUNT(t.turn_id) AS turns,
         SUM(COALESCE(t.tool_calls, 0)) AS toolCalls,
         SUM(COALESCE(t.input_tokens, 0) + COALESCE(t.output_tokens, 0)
             + COALESCE(t.reasoning_tokens, 0)) AS tokens,
         SUM(t.cost_usd) AS costUsd,
         SUM(t.duration_ms) AS wallMs,
         SUM(CASE WHEN t.error_category IS NOT NULL THEN 1 ELSE 0 END)
           AS providerErrors,
         SUM(COALESCE(t.compacted, 0)) AS compactions
    FROM obs_turn AS t
    JOIN obs_thread AS th ON th.thread_id = t.thread_id
   WHERE COALESCE(t.completed_at, t.started_at, '') >= ?`;

function sessionRowsSql(threadHoles = 0): string {
  const filter =
    threadHoles === 0
      ? ""
      : ` AND th.thread_id IN (${Array.from({ length: threadHoles }, () => "?").join(", ")})`;
  return `${SESSION_ROWS_HEAD}${filter}\n   GROUP BY th.thread_id`;
}


export function auditSessions(
  deps: AuditDeps,
  range: SpendRange,
): AuditSessionRow[] {
  const now = deps.now?.() ?? new Date();
  return deps.db
    .prepare<[string], AuditSessionRow>(`${sessionRowsSql()} ORDER BY costUsd DESC`)
    .all(rangeStart(range, now.getTime()));
}

/** The 7-day median of every metric, across sessions. Null with no sessions. */
export function sessionMedians(
  deps: AuditDeps,
): Record<MetricKey, number | null> {
  const rows = auditSessions(deps, "7d");
  const out = {} as Record<MetricKey, number | null>;
  for (const key of METRIC_KEYS) {
    out[key] = median(
      rows
        .map((row) => row[key])
        .filter((value): value is number => typeof value === "number"),
    );
  }
  return out;
}

function threadsFor(deps: AuditDeps, target: AuditTarget): string[] {
  if (target.threadId) return [target.threadId];
  if (!target.runFolder) return [];
  return deps.db
    .prepare<[string], { thread_id: string }>(
      "SELECT thread_id FROM obs_thread WHERE run_folder = ? ORDER BY thread_id",
    )
    .all(target.runFolder)
    .map((row) => row.thread_id);
}

interface ThreadItem {
  thread_id: string;
  item_id: string;
  kind: string | null;
  name: string | null;
  path: string | null;
  seq: number | null;
  at: string | null;
}

function threadItems(db: Database, threadIds: readonly string[]): ThreadItem[] {
  if (threadIds.length === 0) return [];
  const holes = threadIds.map(() => "?").join(", ");
  return db
    .prepare<string[], ThreadItem>(
      // Ordered by thread first: `seq` counts within one thread, so a mixed
      // order interleaves two runs and lets one thread's test command verify
      // another thread's edit.
      `SELECT thread_id, item_id, kind, name, path, seq,
              COALESCE(completed_at, started_at) AS at
         FROM obs_item
        WHERE thread_id IN (${holes})
        ORDER BY thread_id, COALESCE(seq, 0), item_id`,
    )
    .all(...threadIds);
}

function isCommand(item: ThreadItem): boolean {
  return COMMAND_KINDS.includes(item.kind ?? "");
}

function looksLikeVerification(item: ThreadItem): boolean {
  return VERIFICATION_PATTERN.test(`${item.name ?? ""} ${item.path ?? ""}`);
}

export interface VerificationResult {
  verification: AuditVerification;
  unverifiedEdits: AuditUnverifiedEdit[];
}

/**
 * Which edits were never followed by a command that could have caught a
 * mistake in them.
 *
 * Walked backwards on purpose: the question is about what came AFTER an edit,
 * and one reverse pass answers it for every edit at once. An edit followed by
 * a verification command later in the same thread is verified even when a
 * dozen further edits sit between the two.
 */
export function detectVerification(items: readonly ThreadItem[]): VerificationResult {
  const commands = items.filter(isCommand);
  const verified = commands.filter(looksLikeVerification);
  const textAvailable = verified.length > 0;
  const boundary = new Set(
    (textAvailable ? verified : commands).map((item) => item.item_id),
  );
  const unverifiedEdits: AuditUnverifiedEdit[] = [];
  let seenBoundaryAfter = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] as ThreadItem;
    if (boundary.has(item.item_id)) {
      seenBoundaryAfter = true;
      continue;
    }
    if (item.kind === "fileChange" && !seenBoundaryAfter) {
      unverifiedEdits.push({
        itemId: item.item_id,
        path: item.path,
        at: item.at,
      });
    }
  }
  unverifiedEdits.reverse();
  const lastVerified = verified.at(-1)?.at ?? null;
  return {
    verification: {
      commands: commands.length,
      verificationCommands: verified.length,
      lastVerifiedAt: lastVerified,
      textAvailable,
    },
    unverifiedEdits,
  };
}

/**
 * The same detection per thread, merged.
 *
 * Verification never crosses a thread boundary: one seat's `npm test` says
 * nothing about what another seat edited, so each thread is walked alone and
 * only the counts are added up.
 */
export function detectVerificationByThread(
  items: readonly ThreadItem[],
): VerificationResult {
  const byThread = new Map<string, ThreadItem[]>();
  for (const item of items) {
    const bucket = byThread.get(item.thread_id);
    if (bucket) bucket.push(item);
    else byThread.set(item.thread_id, [item]);
  }
  let commands = 0;
  let verificationCommands = 0;
  let lastVerifiedAt: string | null = null;
  const unverifiedEdits: AuditUnverifiedEdit[] = [];
  for (const bucket of byThread.values()) {
    const result = detectVerification(bucket);
    commands += result.verification.commands;
    verificationCommands += result.verification.verificationCommands;
    const at = result.verification.lastVerifiedAt;
    if (at !== null && (lastVerifiedAt === null || at > lastVerifiedAt)) {
      lastVerifiedAt = at;
    }
    unverifiedEdits.push(...result.unverifiedEdits);
  }
  return {
    verification: {
      commands,
      verificationCommands,
      lastVerifiedAt,
      // True when any thread stored command text: the finding it drives is
      // about the ledger, which is one store across all of them.
      textAvailable: verificationCommands > 0,
    },
    unverifiedEdits,
  };
}

function metricDelta(
  value: number | null,
  medianValue: number | null,
): number | null {
  if (value === null || medianValue === null || medianValue === 0) return null;
  return value / medianValue - 1;
}

/**
 * A metric in the units a reader thinks in. The raw float is the arithmetic,
 * not the sentence: "373.6198315 is over the median 1.9738959999999999" makes
 * a reader parse digits to find a number they already knew was big.
 */
export function metricText(key: string, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  if (key === "costUsd") return value.toFixed(2);
  return Math.round(value).toLocaleString("en-US");
}

/** A metric this far above its median is worth a line in the report. */
const OUTLIER_DELTA = 0.5;

export function auditSession(
  deps: AuditDeps,
  target: AuditTarget,
): AuditSessionView {
  const threads = threadsFor(deps, target);
  // No range floor here: a session is audited whenever it ran, and the
  // comparison it is judged against carries the 7-day window instead.
  const rows =
    threads.length === 0
      ? []
      : deps.db
          .prepare<string[], AuditSessionRow>(sessionRowsSql(threads.length))
          .all("", ...threads);
  const totals = {} as Record<MetricKey, number | null>;
  for (const key of METRIC_KEYS) {
    const values = rows
      .map((row) => row[key])
      .filter((value): value is number => typeof value === "number");
    totals[key] = values.length === 0 ? null : values.reduce((a, b) => a + b, 0);
  }
  const medians = sessionMedians(deps);
  const metrics: AuditMetric[] = METRIC_KEYS.map((key) => ({
    metric: key,
    value: totals[key],
    median: medians[key],
    delta: metricDelta(totals[key], medians[key]),
  }));

  const { verification, unverifiedEdits } = detectVerificationByThread(
    threadItems(deps.db, threads),
  );
  const findings: AuditFinding[] = [];
  for (const metric of metrics) {
    if (metric.delta !== null && metric.delta >= OUTLIER_DELTA) {
      findings.push({
        code: `above-median:${metric.metric}`,
        detail: `${metric.metric} ${metricText(metric.metric, metric.value)} is ${(
          metric.delta * 100
        ).toFixed(0)}% over the 7d median ${metricText(
          metric.metric,
          metric.median,
        )}`,
      });
    }
  }
  if (verification.commands === 0) {
    findings.push({
      code: "no-verification",
      detail: "the session ran no command that could have caught a mistake",
    });
  }
  if (unverifiedEdits.length > 0) {
    findings.push({
      code: "unverified-edits",
      detail: `${unverifiedEdits.length} file changes had no command after them`,
    });
  }
  if (!verification.textAvailable && verification.commands > 0) {
    findings.push({
      code: "verification-text-unavailable",
      detail:
        "no command text is stored, so any command was treated as the verification boundary",
    });
  }
  return {
    threadId: target.threadId ?? null,
    runFolder: target.runFolder ?? rows[0]?.runFolder ?? null,
    threads,
    metrics,
    verification,
    unverifiedEdits,
    findings,
  };
}

/** Entries kept in the agent-facing pack, so its size is bounded by shape. */
const PACK_FAILURES = 5;
const PACK_EDITS = 5;
const PACK_FACET_ROWS = 3;
const PACK_FINDINGS = 5;

/**
 * The pack the `harness-audit` skill reads.
 *
 * Its lenses are the reason each field is here: tool economy reads the tool
 * and token metrics against the median, automated checks reads verification
 * and unverified edits, and the failure signatures are the evidence a lens
 * finding has to cite. Bounded by construction rather than truncated, because
 * a pack that loses its tail mid-JSON is a pack the skill cannot parse.
 */
export function buildAuditPack(deps: AuditDeps, target: AuditTarget) {
  const session = auditSession(deps, target);
  const failures = failureRows(deps, { range: "7d" }).slice(0, PACK_FAILURES);
  const facets = auditInsights(deps, "7d").map((facet) => ({
    facet: facet.facet,
    unit: facet.unit,
    rows: facet.rows.slice(0, PACK_FACET_ROWS).map((row) => ({
      label: row.label.slice(0, 60),
      value: Number(row.value.toFixed(4)),
      share: Number(row.share.toFixed(3)),
      actionable: row.actionable,
    })),
  }));
  return {
    threadId: session.threadId,
    runFolder: session.runFolder,
    threads: session.threads.length,
    metrics: session.metrics.map((metric) => ({
      metric: metric.metric,
      value: metric.value,
      median7d: metric.median,
      delta: metric.delta === null ? null : Number(metric.delta.toFixed(3)),
    })),
    verification: session.verification,
    unverifiedEdits: session.unverifiedEdits.slice(0, PACK_EDITS).map((edit) => ({
      path: edit.path === null ? null : edit.path.slice(-60),
      at: edit.at,
    })),
    unverifiedEditCount: session.unverifiedEdits.length,
    findings: session.findings.slice(0, PACK_FINDINGS),
    failures: failures.map((row) => ({
      signature: row.signature.slice(0, 80),
      count: row.count,
      lastSeen: row.lastSeen,
    })),
    facets,
  };
}

function money(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}

export function auditMarkdown(session: AuditSessionView): string {
  const lines = [
    `# Audit: ${session.runFolder ?? session.threadId ?? "session"}`,
    "",
    "| metric | value | 7d median | delta |",
    "| --- | --- | --- | --- |",
  ];
  for (const metric of session.metrics) {
    lines.push(
      `| ${metric.metric} | ${
        metric.metric === "costUsd" ? money(metric.value) : (metric.value ?? "n/a")
      } | ${
        metric.metric === "costUsd"
          ? money(metric.median)
          : (metric.median ?? "n/a")
      } | ${metric.delta === null ? "n/a" : `${(metric.delta * 100).toFixed(0)}%`} |`,
    );
  }
  lines.push(
    "",
    "## Verification",
    "",
    `- commands: ${session.verification.commands}`,
    `- verification commands: ${session.verification.verificationCommands}`,
    `- last verified: ${session.verification.lastVerifiedAt ?? "n/a"}`,
    `- command text available: ${session.verification.textAvailable}`,
    "",
    `## Unverified edits (${session.unverifiedEdits.length})`,
    "",
  );
  for (const edit of session.unverifiedEdits.slice(0, 20)) {
    lines.push(`- ${edit.path ?? edit.itemId} (${edit.at ?? "n/a"})`);
  }
  lines.push("", "## Findings", "");
  if (session.findings.length === 0) lines.push("- none");
  for (const finding of session.findings) {
    lines.push(`- **${finding.code}** ${finding.detail}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Refuse any path that is not inside the run folder.
 *
 * The export is the only thing this module writes, and a folder argument is
 * operator input: a `..` in it would turn a report into an overwrite. Both
 * sides go through `realpath` so a symlinked tmpdir cannot put the root and
 * the target on different spellings of the same directory; a path that does
 * not exist yet (every report, before it is written) falls back to
 * `resolve`, which is all the containment check needs.
 */
export function assertInside(runFolder: string, filename: string): string {
  const root = canonical(runFolder);
  const target = canonical(filename);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`refusing to write outside the run folder: ${filename}`);
  }
  // The check above is symlink-aware but the return keeps the caller's
  // spelling, exactly what `resolve` always returned here.
  return resolve(filename);
}

/**
 * `realpath` where possible, `resolve` where the path is not on disk yet.
 *
 * A report never exists before it is written, so `realpath` on the full path
 * always fails for one. Falling back on the whole path then splits the two
 * sides across spellings wherever the parent is symlinked (every tmpdir on
 * macOS), and the write refuses itself. The longest existing prefix is
 * canonicalized instead, so root and target always meet on one spelling.
 */
function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    const leaves: string[] = [basename(absolute)];
    let dir = dirname(absolute);
    for (;;) {
      try {
        return join(realpathSync(dir), ...leaves);
      } catch {
        const parent = dirname(dir);
        if (parent === dir) return absolute;
        leaves.unshift(basename(dir));
        dir = parent;
      }
    }
  }
}

export interface ExportResult {
  content: string;
  filename: string;
}

export function auditExport(
  deps: AuditDeps,
  target: AuditTarget,
  format: "json" | "md",
): ExportResult {
  const session = auditSession(deps, target);
  const folder = session.runFolder;
  const name = format === "json" ? "audit.json" : "audit.md";
  const content =
    format === "json"
      ? `${JSON.stringify(buildAuditPack(deps, target), null, 2)}\n`
      : auditMarkdown(session);
  return {
    content,
    filename: folder ? assertInside(folder, resolve(folder, name)) : name,
  };
}

/**
 * Write `audit.json`, `audit.md` and the spend module's `COST.md` into the run
 * folder. `COST.md` is the spend writer's output verbatim: two generators of
 * one file is how the retro seat ends up with two answers.
 */
export function writeAuditPack(
  deps: AuditDeps,
  runFolder: string,
): string[] {
  const target: AuditTarget = { runFolder };
  const written: string[] = [];
  for (const format of ["json", "md"] as const) {
    const result = auditExport(deps, target, format);
    writeFileSync(result.filename, result.content, "utf8");
    written.push(result.filename);
  }
  const cost = buildCostMd(deps.db, { runFolder });
  const costPath = assertInside(runFolder, cost.filename);
  writeFileSync(costPath, cost.content, "utf8");
  written.push(costPath);
  return written;
}

/**
 * The pack, plus the files it left behind.
 *
 * The agent-facing tool and the retro seat read the same audit; when the
 * target names a run folder AND the caller passes `write`, the tool writes
 * the three artifacts there so the two never disagree about which run was
 * measured. Reads stay reads by default: an agent asking "how did this run
 * go" must not leave files behind as a side effect. With no run folder
 * there is nowhere to write, and `written` is empty rather than a guessed
 * location.
 */
export function auditPackWithExport(
  deps: AuditDeps,
  target: AuditTarget,
  options: { write?: boolean } = {},
) {
  const pack = buildAuditPack(deps, target);
  const written =
    options.write === true && pack.runFolder !== null
      ? writeAuditPack(deps, pack.runFolder)
      : [];
  return { ...pack, written };
}

export function formatSessions(rows: readonly AuditSessionRow[]): string {
  if (rows.length === 0) return "no sessions in range";
  const lines = [
    `${"thread".padEnd(24)} ${"turns".padStart(6)} ${"tools".padStart(
      6,
    )} ${"tokens".padStart(10)} ${"usd".padStart(9)} ${"errs".padStart(
      5,
    )} ${"comp".padStart(5)}  seat`,
  ];
  for (const row of rows) {
    lines.push(
      `${row.threadId.slice(0, 24).padEnd(24)} ${String(row.turns).padStart(
        6,
      )} ${String(row.toolCalls).padStart(6)} ${String(row.tokens).padStart(
        10,
      )} ${money(row.costUsd).padStart(9)} ${String(
        row.providerErrors,
      ).padStart(5)} ${String(row.compactions).padStart(5)}  ${
        row.seat ?? row.title ?? ""
      }`,
    );
  }
  return lines.join("\n");
}

export function formatSession(session: AuditSessionView): string {
  return auditMarkdown(session).trimEnd();
}
