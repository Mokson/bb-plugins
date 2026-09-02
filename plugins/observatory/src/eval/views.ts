// The one builder per eval read. The rpc returns these as is and the CLI
// formats the SAME objects, so the panel and the terminal cannot drift.
import type {
  EvalCaseResultView,
  EvalCaseSummary,
  EvalCasesView,
  EvalRunSummary,
  EvalRunView,
  EvalRunsView,
} from "./contract.js";
import type { LoadedCase } from "./cases.js";
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

export function runView(deps: EvalDeps, runId: string): EvalRunView {
  const row = deps.store.run(runId);
  return {
    run: row === null ? null : runSummary(row),
    // An unknown run id yields an empty result list rather than an error: the
    // panel renders "no such run" better than it renders a thrown rpc.
    results: row === null ? [] : deps.store.caseResults(runId).map(caseResultView),
  };
}
