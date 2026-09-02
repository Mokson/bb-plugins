// The two eval reads the panel needs beyond a list of names.
//
// The cases read carries the PARSED body, so the detail page describes what a
// case does without re-reading the YAML the server already parsed; and
// `observatory_eval_baseline` exposes the promoted baseline so the run page can
// draw the same deltas the gate grades. Both are reads: PRODUCT.md invariant 5
// keeps every baseline WRITE on `eval baseline promote`, and the second test
// below pins that this read cannot move one.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promoteBaseline } from "../src/eval/baseline.js";
import { EvalStore } from "../src/eval/store.js";
import { baselineView, casesView, loadCases, type EvalDeps } from "../src/eval/views.js";
import { caseYaml, makeGitFixture, writeCases, type GitFixture } from "./eval-fixtures.js";
import { TempDatabase } from "./fakes.js";

describe("the eval reads carry a case body and the promoted baseline", () => {
  let temp: TempDatabase;
  let store: EvalStore;
  let fixture: GitFixture;
  let deps: EvalDeps;

  beforeEach(() => {
    temp = new TempDatabase();
    store = new EvalStore(temp.openDatabase());
    fixture = makeGitFixture();
    deps = {
      store,
      casesDir: writeCases(fixture.root, {
        alpha: caseYaml("alpha", fixture, { trials: 3 }),
        // A file that does not parse, so the body must come back null rather
        // than as an invented shape for a case nobody can run.
        broken: "name: broken\nassert:\n  trace:\n    max_turnz: 4\n",
      }),
    };
  });

  afterEach(() => {
    temp.dispose();
    fixture.dispose();
  });

  it("carries the parsed fixture, invocation, limits and assertion keys", () => {
    const view = casesView(deps, loadCases(deps));
    const alpha = view.cases.find((entry) => entry.name === "alpha");

    expect(alpha?.body).not.toBeNull();
    expect(alpha?.body?.fixture.baseBranch).toBe("fixture/base");
    expect(alpha?.body?.fixture.sha).toBe(fixture.baseSha);
    expect(alpha?.body?.invocation.text).toBe("/deliver tracker:none do the thing");
    expect(alpha?.body?.limits.costCeilingUsd).toBe(8);
    expect(alpha?.body?.limits.maxTotalTokens).toBe(4_000_000);
    expect(alpha?.body?.trials).toBe(3);
    // The KEYS the case declares, not their values.
    expect(alpha?.body?.assertionKeys).toEqual(["ledger"]);
  });

  it("returns a null body for a case that did not parse", () => {
    const view = casesView(deps, loadCases(deps));
    const broken = view.cases.find((entry) => entry.name === "broken");

    expect(broken?.valid).toBe(false);
    expect(broken?.error).not.toBeNull();
    expect(broken?.body).toBeNull();
  });

  it("reads the promoted baseline's run id and per-case metrics", () => {
    expect(baselineView(deps).cases).toEqual([]);

    store.insertRun({
      id: "run-1",
      started_at: "2026-09-01T00:00:00.000Z",
      finished_at: "2026-09-01T01:00:00.000Z",
      tag: "smoke",
      stack_sha: "abc",
      cases_json: JSON.stringify(["alpha"]),
      status: "finished",
      gate: "pass",
    });
    store.upsertCaseResult({
      run_id: "run-1",
      case: "alpha",
      trial: 1,
      status: "pass",
      assertions_json: null,
      metrics_json: JSON.stringify({ tokens: 900, costUsd: 3, wallMs: 60 }),
      thread_id: "thr-1",
      artifacts_dir: null,
    });
    promoteBaseline({
      store,
      runId: "run-1",
      promotedAt: "2026-09-01T02:00:00.000Z",
    });

    const view = baselineView(deps);
    expect(view.cases).toHaveLength(1);
    expect(view.cases[0]?.case).toBe("alpha");
    expect(view.cases[0]?.runId).toBe("run-1");
    expect(view.cases[0]?.promotedAt).toBe("2026-09-01T02:00:00.000Z");
    expect(view.cases[0]?.metrics).toMatchObject({ tokens: 900, costUsd: 3 });
  });

  it("does not itself move a baseline, however often it is read", () => {
    store.promoteBaselineRow({
      case: "alpha",
      run_id: "run-1",
      metrics_json: JSON.stringify({ tokens: 900 }),
      promoted_at: "2026-09-01T02:00:00.000Z",
    });

    const before = baselineView(deps);
    baselineView(deps);
    expect(baselineView(deps)).toEqual(before);
  });
});
