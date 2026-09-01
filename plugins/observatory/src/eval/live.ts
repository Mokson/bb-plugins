// `eval run`: the whole suite, one trial at a time.
//
// Trials are sequential rather than parallel, deliberately. Every case drives
// a full deliver run with its own subagents, so two in flight would compete
// for the same provider rate limits and turn a cost measurement into a
// measurement of contention. The suite is a nightly, not a hot path.
//
// The run row is written BEFORE the first spawn and finished afterwards, so a
// crashed process leaves a `running` row an operator can find and cancel
// rather than a silent gap.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Database } from "better-sqlite3";
import type { EvalCase, LoadedCase } from "./cases.js";
import type { GitRunner } from "./dryrun.js";
import {
  buildSpawnPlan,
  execGit,
  makeRunId,
  provisionWorktree,
  stackSha,
} from "./dryrun.js";
import type { GateReport } from "./gate.js";
import { evaluateGate } from "./gate.js";
import { teardownWorktree } from "./harvest.js";
import type { RunCaseResult } from "./runner.js";
import { runCase } from "./runner.js";
import type { EvalStore } from "./store.js";

export interface LiveRunOptions {
  bb: BbPluginApi;
  db: Database;
  store: EvalStore;
  selected: readonly LoadedCase[];
  worktreeRoot: string;
  artifactsRoot: string;
  tag?: string;
  /** Overrides each case's own `trials`. */
  trials?: number;
  gate?: boolean;
  checkLedgerScript?: string;
  runId?: string;
  now?: () => Date;
  pollMs?: number;
  git?: GitRunner;
}

export interface TrialOutcome {
  case: string;
  trial: number;
  result: RunCaseResult;
}

export interface LiveRunReport {
  runId: string;
  stackSha: string | null;
  startedAt: string;
  finishedAt: string;
  cases: readonly string[];
  outcomes: readonly TrialOutcome[];
  invalid: ReadonlyArray<{ name: string; path: string; error: string }>;
  gate: GateReport | null;
}

function failedTrial(
  name: string,
  trial: number,
  detail: string,
): TrialOutcome {
  return {
    case: name,
    trial,
    result: {
      status: "error",
      threadId: null,
      artifactsDir: null,
      assertions: null,
      metrics: { turns: 0, toolCalls: 0, tokens: 0, costUsd: 0, providerErrors: 0, subthreads: 0, wallMs: 0 },
      failReason: "spawn-failed",
      worktreeKept: false,
      detail,
    },
  };
}

export async function liveRun(options: LiveRunOptions): Promise<LiveRunReport> {
  const git = options.git ?? execGit;
  const clock = options.now ?? (() => new Date());
  const startedAt = clock().toISOString();
  const runId = options.runId ?? makeRunId(new Date(startedAt));

  const invalid = options.selected
    .filter((entry) => entry.value === null)
    .map((entry) => ({
      name: entry.name,
      path: entry.path,
      error: entry.error ?? "unknown error",
    }));
  const valid = options.selected.flatMap((entry) => (entry.value ? [entry.value] : []));
  const names = valid.map((value) => value.name);

  const agentsDir = valid[0]?.harness.agents_dir;
  const sha = agentsDir === undefined ? null : stackSha(agentsDir, git);

  options.store.insertRun({
    id: runId,
    started_at: startedAt,
    finished_at: null,
    tag: options.tag ?? null,
    stack_sha: sha,
    cases_json: JSON.stringify(names),
    status: "running",
    gate: null,
  });

  const outcomes: TrialOutcome[] = [];
  for (const value of valid) {
    const trials = options.trials ?? value.trials;
    for (let trial = 1; trial <= trials; trial += 1) {
      // A cancel between trials stops the suite; the runner handles a cancel
      // that lands mid-trial.
      if (options.store.run(runId)?.status === "cancelled") break;
      outcomes.push(await runTrial(options, { runId, value, trial, sha, git }));
    }
  }

  for (const outcome of outcomes) {
    const { result } = outcome;
    options.store.upsertCaseResult({
      run_id: runId,
      case: outcome.case,
      trial: outcome.trial,
      status: result.status,
      assertions_json: JSON.stringify(result.assertions),
      metrics_json: JSON.stringify(result.metrics),
      thread_id: result.threadId,
      artifacts_dir: result.artifactsDir,
    });
  }

  const finishedAt = clock().toISOString();
  const run = options.store.run(runId);
  const cancelled = run?.status === "cancelled";
  const gate =
    options.gate === true && run !== null && !cancelled
      ? evaluateGate({
          run,
          results: options.store.caseResults(runId),
          baselines: options.store.baselines(),
        })
      : null;
  const status = cancelled
    ? "cancelled"
    : invalid.length > 0 || outcomes.some((entry) => entry.result.status !== "pass")
      ? "fail"
      : "pass";
  options.store.finishRun(runId, finishedAt, status, gate?.verdict ?? null);

  return {
    runId,
    stackSha: sha,
    startedAt,
    finishedAt,
    cases: names,
    outcomes,
    invalid,
    gate,
  };
}

async function runTrial(
  options: LiveRunOptions,
  context: {
    runId: string;
    value: EvalCase;
    trial: number;
    sha: string | null;
    git: GitRunner;
  },
): Promise<TrialOutcome> {
  const { runId, value, trial, sha, git } = context;
  const worktree = `${options.worktreeRoot}/${runId}/${value.name}-${trial}`;
  try {
    provisionWorktree(value, worktree, git);
  } catch (error) {
    // The tree may exist despite the failure, so it is torn down here rather
    // than left for the runner that will never see it.
    teardownWorktree({ case: value, worktree, failed: true, git });
    return failedTrial(
      value.name,
      trial,
      `provisioning failed: ${error instanceof Error ? error.message.trim() : String(error)}`,
    );
  }
  const result = await runCase({
    bb: options.bb,
    db: options.db,
    store: options.store,
    runId,
    case: value,
    trial,
    worktree,
    spawn: buildSpawnPlan(value, worktree, trial, runId),
    artifactsRoot: options.artifactsRoot,
    stackShaAtStart: sha,
    ...(options.checkLedgerScript === undefined
      ? {}
      : { checkLedgerScript: options.checkLedgerScript }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
    git,
  });
  return { case: value.name, trial, result };
}

/** The operator-facing run report. The CLI prints this verbatim. */
export function formatLiveRun(report: LiveRunReport): string {
  const lines = [
    `run ${report.runId}  started ${report.startedAt}  finished ${report.finishedAt}`,
    `stack ${report.stackSha ?? "unknown"}`,
    `cases ${report.cases.length}  trials ${report.outcomes.length}`,
  ];
  for (const entry of report.invalid) {
    lines.push("", `INVALID ${entry.name}  ${entry.path}`, `  ${entry.error}`);
  }
  for (const outcome of report.outcomes) {
    const { result } = outcome;
    lines.push(
      "",
      `${result.status.toUpperCase().padEnd(7)} ${outcome.case} trial ${outcome.trial}  thread ${
        result.threadId ?? "-"
      }`,
    );
    lines.push(
      `  metrics   ${result.metrics.turns} turns  ${result.metrics.toolCalls} tool calls  ${
        result.metrics.tokens
      } tokens  ${result.metrics.costUsd.toFixed(2)} usd  ${Math.round(
        result.metrics.wallMs / 1000,
      )}s`,
    );
    if (result.artifactsDir !== null) lines.push(`  artifacts ${result.artifactsDir}`);
    if (result.failReason !== null) lines.push(`  reason    ${result.failReason}`);
    if (result.detail !== "") lines.push(`  detail    ${result.detail}`);
    if (result.worktreeKept) lines.push("  worktree  kept (keep_on_fail)");
    for (const assertion of result.assertions?.outcomes ?? []) {
      lines.push(
        `  ${assertion.pass ? "ok  " : "FAIL"} ${assertion.key}: ${assertion.detail}`,
      );
    }
  }
  if (report.gate !== null) {
    lines.push("", `gate ${report.gate.verdict}`);
    for (const line of report.gate.lines) lines.push(`  ${line}`);
  }
  return lines.join("\n");
}
