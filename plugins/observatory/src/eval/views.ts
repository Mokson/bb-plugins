// The one builder per eval read. The rpc returns these as is and the CLI
// formats the SAME objects, so the panel and the terminal cannot drift.
import type {
  EvalBaselineView,
  EvalCaseBody,
  EvalCaseResultView,
  EvalCaseSummary,
  EvalCasesView,
  EvalRunSummary,
  EvalRunView,
  EvalRunsView,
} from "./contract.js";
import type { EvalCase, LoadedCase } from "./cases.js";
import { loadCasesDir } from "./cases.js";
import type { EvalCaseResultRow, EvalRunRow, EvalStore } from "./store.js";

export interface EvalDeps {
  store: EvalStore;
  /** The `eval_casesDir` setting, `~` included. */
  casesDir: string;
}

/** Read the cases directory fresh: a case file is edited outside the plugin. */
export function loadCases(deps: EvalDeps): LoadedCase[] {
  return loadCasesDir(deps.casesDir);
}

/**
 * The wire form of a parsed case.
 *
 * The snake_case YAML keys become the contract's camelCase here rather than in
 * the panel, so the CLI and the page describe a case with the same words.
 * Assertion keys are read off the parsed object, so a key the schema gains
 * shows up without a second edit in this file.
 */
function caseBody(value: EvalCase): EvalCaseBody {
  return {
    fixture: {
      project: value.fixture.project,
      repo: value.fixture.repo,
      baseBranch: value.fixture.base_branch,
      sha: value.fixture.sha,
      dirty: [...value.fixture.dirty],
      envFiles: [...value.fixture.env_files],
    },
    invocation: {
      text: value.invocation.text,
      route: value.invocation.route ?? null,
      mode: value.invocation.mode ?? null,
    },
    limits: {
      timeoutMs: value.limits.timeout_ms,
      costCeilingUsd: value.limits.cost_ceiling_usd,
      maxTotalTokens: value.limits.max_total_tokens,
    },
    assertionKeys: Object.entries(value.assert)
      .filter(([, declared]) => declared !== undefined)
      .map(([key]) => key),
    trials: value.trials,
    retries: value.retries,
  };
}

export function casesView(deps: EvalDeps, cases: readonly LoadedCase[]): EvalCasesView {
  const latest = deps.store.latestResultPerCase();
  return {
    cases: cases.map((entry): EvalCaseSummary => {
      const last = latest.get(entry.name);
      return {
        name: entry.name,
        tags: [...entry.tags],
        path: entry.path,
        valid: entry.value !== null,
        error: entry.error,
        lastResult: last
          ? { runId: last.run_id, trial: last.trial, status: last.status }
          : null,
        body: entry.value === null ? null : caseBody(entry.value),
      };
    }),
  };
}

/** Stored JSON that no longer parses reads as absent, never as a throw. */
function parseJson(json: string | null): unknown {
  if (json === null) return null;
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function parseCases(json: string | null): string[] {
  const value = parseJson(json);
  return Array.isArray(value) ? value.filter((name) => typeof name === "string") : [];
}

export function runSummary(row: EvalRunRow): EvalRunSummary {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    tag: row.tag,
    stackSha: row.stack_sha,
    cases: parseCases(row.cases_json),
    status: row.status,
    gate: row.gate,
  };
}

export function caseResultView(row: EvalCaseResultRow): EvalCaseResultView {
  return {
    case: row.case,
    trial: row.trial,
    status: row.status,
    threadId: row.thread_id,
    artifactsDir: row.artifacts_dir,
    assertions: parseJson(row.assertions_json),
    metrics: parseJson(row.metrics_json),
  };
}

export function runsView(deps: EvalDeps, limit: number): EvalRunsView {
  return { runs: deps.store.runs(limit).map(runSummary) };
}

/**
 * Every promoted baseline, one row per case.
 *
 * Sorted by case name so the panel and `bb observatory eval baseline show`
 * list them in the same order; the store's map is insertion-ordered by
 * whatever SQLite returned.
 */
export function baselineView(deps: EvalDeps): EvalBaselineView {
  return {
    cases: [...deps.store.baselines().values()]
      .map((row) => ({
        case: row.case,
        runId: row.run_id,
        metrics: parseJson(row.metrics_json),
        promotedAt: row.promoted_at,
      }))
      .sort((a, b) => a.case.localeCompare(b.case)),
  };
}

export function runView(deps: EvalDeps, runId: string): EvalRunView {
  const row = deps.store.run(runId);
  return {
    run: row === null ? null : runSummary(row),
    // An unknown run id yields an empty result list rather than an error: the
    // panel renders "no such run" better than it renders a thrown rpc.
    results: row === null ? [] : deps.store.caseResults(runId).map(caseResultView),
  };
}
