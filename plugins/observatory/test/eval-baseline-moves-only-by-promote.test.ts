// PRODUCT.md invariant 5: an eval baseline changes ONLY through
// `eval baseline promote <run>`.
//
// The test drives the two surfaces that would be most tempting to let write
// one — a finished run and a gate — and asserts the table is still empty
// afterwards. A baseline that a run could move would quietly ratify whatever
// the stack last did, including a regression.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promoteBaseline } from "../src/eval/baseline.js";
import { evaluateGate } from "../src/eval/gate.js";
import { EvalStore } from "../src/eval/store.js";
import { TempDatabase } from "./fakes.js";

describe("an eval baseline moves only by promote", () => {
  let temp: TempDatabase;
  let store: EvalStore;

  beforeEach(() => {
    temp = new TempDatabase();
    store = new EvalStore(temp.openDatabase());
    store.insertRun({
      id: "run-1",
      started_at: "2026-09-01T00:00:00.000Z",
      finished_at: null,
      tag: "smoke",
      stack_sha: "abc",
      cases_json: JSON.stringify(["alpha"]),
      status: "running",
      gate: null,
    });
    for (const [trial, cost] of [
      [1, 2],
      [2, 5],
    ] as const) {
      store.upsertCaseResult({
        run_id: "run-1",
        case: "alpha",
        trial,
        status: "pass",
        assertions_json: null,
        metrics_json: JSON.stringify({ tokens: 100 * trial, costUsd: cost, wallMs: 10 }),
        thread_id: `thr-${trial}`,
        artifacts_dir: null,
      });
    }
  });
  afterEach(() => temp.dispose());

  it("leaves the table empty after a run finishes and a gate grades it", () => {
    store.finishRun("run-1", "2026-09-01T01:00:00.000Z", "pass", null);
    evaluateGate({
      run: store.run("run-1")!,
      results: store.caseResults("run-1"),
      baselines: store.baselines(),
    });
    expect(store.baselines().size).toBe(0);
  });

  it("promotes the worst passing trial, so the next run is not a false regression", () => {
    const report = promoteBaseline({
      store,
      runId: "run-1",
      promotedAt: "2026-09-01T02:00:00.000Z",
    });
    expect(report.promoted).toEqual(["alpha"]);
    const row = store.baselines().get("alpha");
    expect(row?.run_id).toBe("run-1");
    expect(JSON.parse(row!.metrics_json!)).toMatchObject({ costUsd: 5, tokens: 200 });
  });

  it("refuses to promote a case whose trials did not all pass", () => {
    store.upsertCaseResult({
      run_id: "run-1",
      case: "alpha",
      trial: 2,
      status: "fail",
      assertions_json: null,
      metrics_json: JSON.stringify({ tokens: 200, costUsd: 5, wallMs: 10 }),
      thread_id: "thr-2",
      artifacts_dir: null,
    });
    const report = promoteBaseline({
      store,
      runId: "run-1",
      promotedAt: "2026-09-01T02:00:00.000Z",
    });
    expect(report.promoted).toEqual([]);
    expect(report.skipped[0]?.reason).toContain("not every trial passed");
    expect(store.baselines().size).toBe(0);
  });
});
