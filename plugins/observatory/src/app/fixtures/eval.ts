// Synthetic eval data for `?fixture=1`.
//
// Every id says `fixture`, so a screenshot taken from this data can never be
// mistaken for a real regression report. It exists to render the pages -
// verdict words, an invalid case, a failed assertion, absent metrics - and it
// is typed against the shipped contract, so a contract change breaks it
// loudly rather than quietly rendering the wrong shape.
import type {
  EvalBaselineView,
  EvalCaseBody,
  EvalCasesView,
  EvalRunView,
  EvalRunsView,
} from "../../eval/contract.js";

export const FIXTURE_RUN_ID = "run_fixture_1";
export const FIXTURE_CASE_NAME = "fixture-deliver-normal";

/**
 * One parsed case body, varied per case by its route and assertion keys.
 *
 * The fixture and limits are shared: they are the same shape for every case
 * and repeating three literal blocks would only make a contract change three
 * edits instead of one.
 */
function fixtureBody(route: string, assertionKeys: string[]): EvalCaseBody {
  return {
    fixture: {
      project: "fixture-project",
      repo: "/fixture/repos/deliver-fixture",
      baseBranch: "main",
      sha: "fixture0000000000000000000000000000000a1",
      dirty: ["patches/seed-backlog.patch"],
      envFiles: [".env.fixture"],
    },
    invocation: {
      text: "deliver the fixture backlog item",
      route,
      mode: null,
    },
    limits: {
      timeoutMs: 5_400_000,
      costCeilingUsd: 12,
      maxTotalTokens: 4_000_000,
    },
    assertionKeys,
    trials: 3,
    retries: 1,
  };
}

export function fixtureCases(): EvalCasesView {
  return {
    cases: [
      {
        name: FIXTURE_CASE_NAME,
        tags: ["deliver", "nightly"],
        path: "/fixture/eval/cases/deliver-normal.yaml",
        valid: true,
        error: null,
        lastResult: { runId: FIXTURE_RUN_ID, trial: 2, status: "pass" },
        body: fixtureBody("normal", ["ledger", "artifacts", "trace"]),
      },
      {
        name: "fixture-deliver-bug",
        tags: ["deliver"],
        path: "/fixture/eval/cases/deliver-bug.yaml",
        valid: true,
        error: null,
        lastResult: { runId: FIXTURE_RUN_ID, trial: 1, status: "fail" },
        body: fixtureBody("bug", ["ledger", "exit_codes", "trace", "output"]),
      },
      {
        name: "fixture-groom-shape",
        tags: ["groom"],
        path: "/fixture/eval/cases/groom-shape.yaml",
        valid: false,
        error: "assert.trace.max_turnz: unrecognized key",
        lastResult: null,
        // Null because the file did not parse: the page must show the error,
        // never a body invented for a case nobody can run.
        body: null,
      },
    ],
  };
}

export function fixtureRuns(): EvalRunsView {
  return {
    runs: [
      {
        id: FIXTURE_RUN_ID,
        startedAt: "2026-08-30T22:00:00.000Z",
        finishedAt: "2026-08-30T23:12:00.000Z",
        tag: "nightly",
        stackSha: "9f3c1ab",
        cases: [FIXTURE_CASE_NAME, "fixture-deliver-bug"],
        status: "finished",
        gate: "fail",
      },
      {
        id: "run_fixture_0",
        startedAt: "2026-08-29T22:00:00.000Z",
        finishedAt: null,
        tag: "nightly",
        stackSha: null,
        cases: [FIXTURE_CASE_NAME],
        status: "cancelled",
        gate: null,
      },
    ],
  };
}

/**
 * The promoted baselines the run page measures its deltas against.
 *
 * Chosen so the render shows both answers: `fixture-deliver-normal` drifts a
 * few percent and stays quiet, while `fixture-deliver-bug` clears every WARN
 * threshold in `DRIFT`, so a screenshot proves the marks appear at all.
 */
export function fixtureBaseline(): EvalBaselineView {
  return {
    cases: [
      {
        case: "fixture-deliver-bug",
        runId: "run_fixture_0",
        metrics: { tokens: 1_150_000, costUsd: 4.0, wallMs: 1_600_000 },
        promotedAt: "2026-08-29T09:00:00.000Z",
      },
      {
        case: FIXTURE_CASE_NAME,
        runId: "run_fixture_0",
        metrics: { tokens: 1_200_000, costUsd: 3.95, wallMs: 1_840_000 },
        promotedAt: "2026-08-29T09:00:00.000Z",
      },
    ],
  };
}

export function fixtureRun(): EvalRunView {
  return {
    run: fixtureRuns().runs[0]!,
    results: [
      {
        case: FIXTURE_CASE_NAME,
        trial: 1,
        status: "pass",
        threadId: "thr_fixture_eval_1",
        artifactsDir: "/fixture/eval/artifacts/run_fixture_1/1",
        assertions: {
          pass: true,
          outcomes: [{ key: "ledger.exists", pass: true, detail: "found" }],
        },
        metrics: { tokens: 1_284_300, costUsd: 4.12, wallMs: 1_920_000 },
      },
      {
        case: FIXTURE_CASE_NAME,
        trial: 2,
        status: "pass",
        threadId: "thr_fixture_eval_2",
        artifactsDir: null,
        // A trial whose metrics never landed: the row stays and reads `--`.
        assertions: null,
        metrics: null,
      },
      {
        case: "fixture-deliver-bug",
        trial: 1,
        status: "fail",
        threadId: "thr_fixture_eval_3",
        artifactsDir: "/fixture/eval/artifacts/run_fixture_1/3",
        assertions: {
          pass: false,
          outcomes: [
            { key: "ledger.exists", pass: true, detail: "found" },
            {
              key: "trace.max_cost_usd",
              pass: false,
              detail: "6.40 over the 5.00 ceiling",
            },
            {
              key: "output.contains",
              pass: false,
              detail: "missing: regression test",
            },
          ],
        },
        metrics: { tokens: 2_010_500, costUsd: 6.4, wallMs: 2_760_000 },
      },
    ],
  };
}
