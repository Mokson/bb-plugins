// `bb observatory eval ...`.
//
// One subcommand word after `eval`, so the dispatch in `server.ts` stays a
// single branch and every eval concern lives here. Exit codes are the
// contract: 0 valid, 1 an invalid case or a bad flag, 2 a surface that part 2
// still owns. `--gate` will read exit codes, so they cannot be decorative.
import type { LoadedCase } from "./cases.js";
import { selectCases } from "./cases.js";
import { dryRun, formatDryRun, worktreeRootFor } from "./dryrun.js";
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
      "Deliver-stack regression cases: list them, validate them, and dry-run their provisioning.",
    usage:
      "bb observatory eval list | validate [--case <name>] | show <runId> | run [--tag <t>] [--case <name>] --dry-run [--keep]",
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
  const width = Math.max(...view.cases.map((entry) => entry.name.length));
  return view.cases
    .map((entry) => {
      const last = entry.lastResult;
      const seen = last === null ? "never run" : `${last.status ?? "?"} in ${last.runId}`;
      const tags = entry.tags.length === 0 ? "-" : entry.tags.join(",");
      return entry.valid
        ? `${entry.name.padEnd(width)}  ok       ${tags}  ${seen}`
        : `${entry.name.padEnd(width)}  INVALID  ${tags}  ${entry.error ?? ""}`;
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
  }
  return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
}

function run(deps: EvalDeps, argv: readonly string[], worktreeRoot: string): CliResult {
  if (!hasFlag(argv, "dry-run")) {
    // Exit 2, not 1: "not built yet" must be distinguishable from "your cases
    // are broken" by anything scripting this command.
    return { exitCode: 2, stderr: "runner arrives in part 2\n" };
  }
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
    worktreeRoot,
  });
  const broken =
    report.invalid.length > 0 || report.plans.some((plan) => plan.error !== null);
  return {
    exitCode: broken ? 1 : 0,
    stdout: `${formatDryRun(report)}\n`,
  };
}

const USAGE = [
  "Usage: bb observatory eval <list|validate|show|run>",
  "",
  "  list                  Every case file, its tags, validity and last result",
  "  validate [--case <n>] Load and schema-check cases; exit 1 on any failure",
  "  show <runId>          One run and its per-case results",
  "  run --dry-run         Provision worktrees, print the plan, spawn nothing",
  "       [--tag <t>] [--case <n>] [--keep]",
].join("\n");

/**
 * Dispatch `eval <sub>`. `argv` excludes the `observatory` and `eval` words.
 * `databasePath` names the sqlite file, which is how the worktree root is
 * derived; tests pass their own root through `deps`.
 */
export function runEvalCommand(
  deps: EvalDeps,
  argv: readonly string[],
  databasePath: string | undefined,
): CliResult {
  const [sub, ...rest] = argv;
  const worktreeRoot = worktreeRootFor(databasePath);
  try {
    if (sub === "list") {
      return { exitCode: 0, stdout: `${formatList(deps, loadCases(deps))}\n` };
    }
    if (sub === "validate") return validate(deps, rest);
    if (sub === "show") return show(deps, rest[0]);
    if (sub === "run") return run(deps, rest, worktreeRoot);
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
