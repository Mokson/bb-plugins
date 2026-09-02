// `bb observatory eval ...`.
//
// One subcommand word after `eval`, so the dispatch in `server.ts` stays a
// single branch and every eval concern lives here. Exit codes are the
// contract, and `--gate` reads them, so they cannot be decorative:
//
//   0  valid, or a gate that passed (or warned without `--strict`)
//   1  an invalid case, a bad flag, a failed gate, a strict warning
//   2  no baseline to compare against, or a surface the host did not wire
//
// The read commands take `EvalDeps` alone. The three that spend money take
// `EvalLiveDeps` as well, and refuse rather than improvise when the host did
// not supply it — a `eval run` that quietly did nothing would be worse than
// one that says it cannot run.
import type { LoadedCase } from "./cases.js";
import { selectCases } from "./cases.js";
import type { EvalLiveDeps } from "./deps.js";
import { dryRun, formatDryRun, worktreeRootFor } from "./dryrun.js";
import { promoteBaseline } from "./baseline.js";
import { gateExitCode } from "./gate.js";
import { artifactsRootFor } from "./harvest.js";
import { formatLiveRun, liveRun } from "./live.js";
import { stopOwnedThread } from "./runner.js";
import {
  DEFAULT_JUDGE_FIXTURES_DIR,
  loadJudgeFixtures,
  runJudge,
  scoreJudge,
} from "./assert.js";
import type { EvalDeps } from "./views.js";
import { casesView, loadCases, runView, runsView } from "./views.js";

export interface CliResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export const EVAL_COMMAND = "eval";

export const EVAL_CLI_COMMANDS = [
  {
    name: "eval",
    summary:
      "Deliver-stack regression cases: list them, run them, gate a run against its baseline.",
    usage:
      "bb observatory eval list | validate | run [--tag <t>] [--case <n>] [--trials <n>] [--gate] [--strict] [--dry-run] | cancel <runId> | runs | show <runId> | baseline promote <runId> | baseline show | judge-validate",
  },
] as const;

function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  // `--case --keep` is a missing value, not a case named "--keep".
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function filterFrom(argv: readonly string[]): { tag?: string; case?: string } {
  const tag = flagValue(argv, "tag");
  const name = flagValue(argv, "case");
  return { ...(tag === undefined ? {} : { tag }), ...(name === undefined ? {} : { case: name }) };
}

function formatList(deps: EvalDeps, cases: readonly LoadedCase[]): string {
  const view = casesView(deps, cases);
  if (view.cases.length === 0) return `no cases in ${deps.casesDir}`;
  const tagsOf = (entry: (typeof view.cases)[number]) =>
    entry.tags.length === 0 ? "-" : entry.tags.join(",");
  const nameWidth = Math.max(...view.cases.map((entry) => entry.name.length));
  const tagWidth = Math.max(...view.cases.map((entry) => tagsOf(entry).length));
  return view.cases
    .map((entry) => {
      const last = entry.lastResult;
      const seen = last === null ? "never run" : `${last.status ?? "?"} in ${last.runId}`;
      const lead = `${entry.name.padEnd(nameWidth)}  ${
        entry.valid ? "ok     " : "INVALID"
      }  ${tagsOf(entry).padEnd(tagWidth)}`;
      return entry.valid ? `${lead}  ${seen}` : `${lead}  ${entry.error ?? ""}`;
    })
    .join("\n");
}

function validate(deps: EvalDeps, argv: readonly string[]): CliResult {
  const filter = filterFrom(argv);
  const selected = selectCases(loadCases(deps), filter);
  if (selected.length === 0) {
    return { exitCode: 1, stderr: `no case matched in ${deps.casesDir}\n` };
  }
  const bad = selected.filter((entry) => entry.value === null);
  const lines = selected.map((entry) =>
    entry.value === null
      ? `FAIL ${entry.name}\n  ${entry.path}\n  ${entry.error ?? "unknown error"}`
      : `ok   ${entry.name}`,
  );
  lines.push(`${selected.length - bad.length}/${selected.length} valid`);
  return bad.length === 0
    ? { exitCode: 0, stdout: `${lines.join("\n")}\n` }
    : { exitCode: 1, stdout: `${lines.join("\n")}\n` };
}

function show(deps: EvalDeps, runId: string | undefined): CliResult {
  if (runId === undefined) {
    return { exitCode: 1, stderr: "usage: bb observatory eval show <runId>\n" };
  }
  const view = runView(deps, runId);
  if (view.run === null) return { exitCode: 1, stderr: `no such run: ${runId}\n` };
  const run = view.run;
  const lines = [
    `run ${run.id}  status ${run.status ?? "?"}  gate ${run.gate ?? "-"}`,
    `started ${run.startedAt ?? "?"}  finished ${run.finishedAt ?? "-"}`,
    `tag ${run.tag ?? "-"}  stack ${run.stackSha ?? "unknown"}`,
    `cases ${run.cases.length === 0 ? "-" : run.cases.join(", ")}`,
  ];
  if (view.results.length === 0) lines.push("", "no case results recorded");
  for (const result of view.results) {
    lines.push(
      `${result.case} trial ${result.trial}  ${result.status ?? "?"}  thread ${
        result.threadId ?? "-"
      }`,
    );
    if (result.artifactsDir !== null) lines.push(`  artifacts ${result.artifactsDir}`);
  }
  return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
}

function runs(deps: EvalDeps, argv: readonly string[]): CliResult {
  const raw = Number(flagValue(argv, "limit") ?? "20");
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 500) : 20;
  const view = runsView(deps, limit);
  if (view.runs.length === 0) return { exitCode: 0, stdout: "no runs recorded\n" };
  const lines = view.runs.map(
    (run) =>
      `${run.id}  ${(run.status ?? "?").padEnd(9)}  gate ${(run.gate ?? "-").padEnd(8)}  ${
        run.cases.length
      } cases  tag ${run.tag ?? "-"}`,
  );
  return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
}

function dryRunCommand(
  deps: EvalDeps,
  argv: readonly string[],
  databasePath: string | undefined,
): CliResult {
  const filter = filterFrom(argv);
  const selected = selectCases(loadCases(deps), filter);
  if (selected.length === 0) {
    return { exitCode: 1, stderr: `no case matched in ${deps.casesDir}\n` };
  }
  const report = dryRun({
    store: deps.store,
    selected,
    ...(filter.tag === undefined ? {} : { tag: filter.tag }),
    keep: hasFlag(argv, "keep"),
    worktreeRoot: worktreeRootFor(databasePath),
  });
  const broken = report.invalid.length > 0 || report.plans.some((plan) => plan.error !== null);
  return { exitCode: broken ? 1 : 0, stdout: `${formatDryRun(report)}\n` };
}

async function run(
  deps: EvalDeps,
  live: EvalLiveDeps | undefined,
  argv: readonly string[],
  databasePath: string | undefined,
): Promise<CliResult> {
  if (hasFlag(argv, "dry-run")) return dryRunCommand(deps, argv, databasePath);
  if (live === undefined) {
    return { exitCode: 2, stderr: "eval run needs the plugin host; use --dry-run\n" };
  }
  const filter = filterFrom(argv);
  const selected = selectCases(loadCases(deps), filter);
  if (selected.length === 0) {
    return { exitCode: 1, stderr: `no case matched in ${deps.casesDir}\n` };
  }
  const trialsRaw = flagValue(argv, "trials");
  const trials = trialsRaw === undefined ? undefined : Number(trialsRaw);
  if (trials !== undefined && (!Number.isInteger(trials) || trials < 1)) {
    return { exitCode: 1, stderr: `--trials must be a positive integer, got "${trialsRaw}"\n` };
  }
  const report = await liveRun({
    bb: live.bb,
    db: live.db,
    store: deps.store,
    selected,
    worktreeRoot: worktreeRootFor(databasePath),
    artifactsRoot: artifactsRootFor(databasePath),
    ...(filter.tag === undefined ? {} : { tag: filter.tag }),
    ...(trials === undefined ? {} : { trials }),
    gate: hasFlag(argv, "gate"),
    ...(live.checkLedgerScript === undefined
      ? {}
      : { checkLedgerScript: live.checkLedgerScript }),
    ...(live.drainThread === undefined
      ? {}
      : { drainThread: (threadId: string) => live.drainThread!(threadId) }),
  });
  const stdout = `${formatLiveRun(report)}\n`;
  if (report.gate !== null) {
    return { exitCode: gateExitCode(report.gate.verdict, hasFlag(argv, "strict")), stdout };
  }
  const failed =
    report.invalid.length > 0 ||
    report.outcomes.some((outcome) => outcome.result.status !== "pass");
  return { exitCode: failed ? 1 : 0, stdout };
}

async function cancel(
  deps: EvalDeps,
  live: EvalLiveDeps | undefined,
  runId: string | undefined,
): Promise<CliResult> {
  if (runId === undefined) {
    return { exitCode: 1, stderr: "usage: bb observatory eval cancel <runId>\n" };
  }
  if (live === undefined) return { exitCode: 2, stderr: "eval cancel needs the plugin host\n" };
  if (deps.store.run(runId) === null) {
    return { exitCode: 1, stderr: `no such run: ${runId}\n` };
  }
  // The status moves first: an in-flight runner reads it between sweeps, so
  // even a thread this process fails to stop is abandoned by its own loop.
  deps.store.cancelRun(runId, new Date().toISOString());
  const lines: string[] = [`run ${runId} cancelled`];
  for (const threadId of deps.store.runThreadIds(runId)) {
    try {
      await stopOwnedThread(live.bb, deps.store, threadId);
      lines.push(`  stopped ${threadId}`);
    } catch (error) {
      lines.push(
        `  could not stop ${threadId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
}

function baseline(deps: EvalDeps, argv: readonly string[]): CliResult {
  const [action, runId] = argv;
  if (action === "show") {
    const rows = [...deps.store.baselines().values()];
    if (rows.length === 0) return { exitCode: 0, stdout: "no baselines promoted\n" };
    const lines = rows
      .sort((left, right) => left.case.localeCompare(right.case))
      .map(
        (row) =>
          `${row.case}  from ${row.run_id ?? "-"}  at ${row.promoted_at ?? "-"}  ${
            row.metrics_json ?? "{}"
          }`,
      );
    return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
  }
  if (action !== "promote") {
    return {
      exitCode: 1,
      stderr: "usage: bb observatory eval baseline <promote <runId> | show>\n",
    };
  }
  if (runId === undefined) {
    return { exitCode: 1, stderr: "usage: bb observatory eval baseline promote <runId>\n" };
  }
  const report = promoteBaseline({
    store: deps.store,
    runId,
    promotedAt: new Date().toISOString(),
  });
  const lines = [
    ...report.promoted.map((name) => `promoted ${name}`),
    ...report.skipped.map((entry) => `skipped  ${entry.case}: ${entry.reason}`),
  ];
  return {
    exitCode: report.promoted.length === 0 ? 1 : 0,
    stdout: `${lines.join("\n")}\n`,
  };
}

async function judgeValidate(
  deps: EvalDeps,
  live: EvalLiveDeps | undefined,
  argv: readonly string[],
): Promise<CliResult> {
  if (live === undefined) {
    return { exitCode: 2, stderr: "eval judge-validate needs the plugin host\n" };
  }
  const model = flagValue(argv, "model");
  if (model === undefined) {
    return {
      exitCode: 1,
      stderr: "usage: bb observatory eval judge-validate --model <provider/model> [--project <id>]\n",
    };
  }
  const projectId = flagValue(argv, "project") ?? live.defaultProjectId;
  if (projectId === undefined) {
    return { exitCode: 1, stderr: "judge-validate needs --project <id>\n" };
  }
  const dir = live.judgeFixturesDir ?? DEFAULT_JUDGE_FIXTURES_DIR;
  const { fixtures, skipped } = loadJudgeFixtures(dir);
  if (fixtures.length === 0) {
    return { exitCode: 1, stderr: `no labelled fixtures in ${dir}\n` };
  }
  const rows: Array<{ name: string; expected: "pass" | "fail"; got: "pass" | "fail" }> = [];
  for (const fixture of fixtures) {
    const verdict = await runJudge({
      bb: live.bb,
      projectId,
      judge: { rubric: fixture.rubric, model },
      // The fixture carries its evidence inline, so the rubric is applied to
      // the same bytes on every machine.
      artifactsDir: "",
      inlineEvidence: fixture.evidence,
    });
    rows.push({ name: fixture.name, expected: fixture.label, got: verdict.verdict });
  }
  const report = scoreJudge(rows);
  const lines = report.rows.map(
    (row) => `${row.correct ? "ok  " : "MISS"} ${row.name}: expected ${row.expected}, got ${row.got}`,
  );
  for (const name of skipped) lines.push(`skip ${name}: not a labelled fixture`);
  lines.push(
    `TPR ${report.tpr.toFixed(2)}  TNR ${report.tnr.toFixed(2)}  threshold ${report.threshold}`,
    report.trusted
      ? "judge is trustworthy; its verdicts count"
      : "judge is ADVISORY only until both rates reach the threshold",
  );
  // Advisory, so a weak judge reports rather than fails the command.
  return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
}

const USAGE = [
  "Usage: bb observatory eval <list|validate|run|cancel|runs|show|baseline|judge-validate>",
  "",
  "  list                   Every case file, its tags, validity and last result",
  "  validate [--case <n>]  Load and schema-check cases; exit 1 on any failure",
  "  run                    Spawn one hidden thread per trial and assert",
  "       [--tag <t>] [--case <n>] [--trials <n>] [--gate] [--strict]",
  "       [--dry-run [--keep]]   Provision and print the plan, spawn nothing",
  "  cancel <runId>         Stop the threads this plugin spawned for a run",
  "  runs [--limit <n>]     Recorded runs, newest first",
  "  show <runId>           One run and its per-case results",
  "  baseline promote <runId> | baseline show",
  "  judge-validate --model <provider/model> [--project <id>]",
].join("\n");

/**
 * Dispatch `eval <sub>`. `argv` excludes the `observatory` and `eval` words.
 * `databasePath` names the sqlite file, which is how the worktree and
 * artifacts roots are derived; tests pass their own roots through `deps`.
 */
export async function runEvalCommand(
  deps: EvalDeps,
  argv: readonly string[],
  databasePath: string | undefined,
  live?: EvalLiveDeps,
): Promise<CliResult> {
  const [sub, ...rest] = argv;
  try {
    if (sub === "list") {
      return { exitCode: 0, stdout: `${formatList(deps, loadCases(deps))}\n` };
    }
    if (sub === "validate") return validate(deps, rest);
    if (sub === "show") return show(deps, rest[0]);
    if (sub === "runs") return runs(deps, rest);
    if (sub === "run") return await run(deps, live, rest, databasePath);
    if (sub === "cancel") return await cancel(deps, live, rest[0]);
    if (sub === "baseline") return baseline(deps, rest);
    if (sub === "judge-validate") return await judgeValidate(deps, live, rest);
    const helpRequested = sub === undefined || sub === "--help" || sub === "-h";
    return helpRequested
      ? { exitCode: 0, stdout: `${USAGE}\n` }
      : { exitCode: 1, stderr: `${USAGE}\n` };
  } catch (error) {
    // A missing fixture, an unreadable case directory, a git that is not
    // installed: all operator answers, printed rather than crashing the CLI.
    return {
      exitCode: 1,
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}
