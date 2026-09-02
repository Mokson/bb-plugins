// The gate matrix. Each row is a different ANSWER, and collapsing any two of
// them would make the gate useless in a specific way:
//
//   fail    a case that was passing is now red — stop
//   warn    same verdict, materially more expensive — look this week
//   warn    newly flaky — one red trial does not prove a regression
//   not-run no baseline — "did it get worse?" has no answer yet, exit 2
//
// `--strict` is the only thing that turns a warning into a stop.
import { describe, expect, it } from "vitest";
import { evaluateGate, gateExitCode } from "../src/eval/gate.js";
import type { EvalBaselineRow, EvalCaseResultRow, EvalRunRow } from "../src/eval/store.js";

function run(cases: readonly string[]): EvalRunRow {
  return {
    id: "run-1",
    started_at: "2026-09-01T00:00:00.000Z",
    finished_at: "2026-09-01T01:00:00.000Z",
    tag: "smoke",
    stack_sha: "abc",
    cases_json: JSON.stringify(cases),
    status: "fail",
    gate: null,
  };
}

function result(
  name: string,
  trial: number,
  status: string,
  metrics: Record<string, number>,
): EvalCaseResultRow {
  return {
    run_id: "run-1",
    case: name,
    trial,
    status,
    assertions_json: null,
    metrics_json: JSON.stringify(metrics),
    thread_id: `thr-${name}-${trial}`,
    artifacts_dir: null,
  };
}

function baseline(name: string, metrics: Record<string, number>): [string, EvalBaselineRow] {
  return [
    name,
    {
      case: name,
      run_id: "run-0",
      metrics_json: JSON.stringify(metrics),
      promoted_at: "2026-08-01T00:00:00.000Z",
    },
  ];
}

const STEADY = { tokens: 1000, costUsd: 1, wallMs: 1000 };

describe("the gate grades regression, drift and absence apart", () => {
  it("fails a case that went from passing to failing", () => {
    const report = evaluateGate({
      run: run(["regressed"]),
      results: [result("regressed", 1, "fail", STEADY)],
      baselines: new Map([baseline("regressed", STEADY)]),
    });
    expect(report.verdict).toBe("fail");
    expect(report.lines[0]).toContain("FAIL regressed");
    expect(gateExitCode(report.verdict, false)).toBe(1);
  });

  it("fails a case the run selected but never recorded", () => {
    const report = evaluateGate({
      run: run(["vanished"]),
      results: [],
      baselines: new Map([baseline("vanished", STEADY)]),
    });
    expect(report.verdict).toBe("fail");
    expect(report.lines[0]).toContain("recorded no result");
  });

  it("warns on token, cost and wall drift over their separate thresholds", () => {
    const report = evaluateGate({
      run: run(["drifted"]),
      // +60% tokens, +50% cost, +70% wall: each clears its own threshold.
      results: [result("drifted", 1, "pass", { tokens: 1600, costUsd: 1.5, wallMs: 1700 })],
      baselines: new Map([baseline("drifted", STEADY)]),
    });
    expect(report.verdict).toBe("warn");
    expect(report.lines[0]).toContain("tokens up");
    expect(report.lines[0]).toContain("cost up");
    expect(report.lines[0]).toContain("wall up");
    expect(gateExitCode(report.verdict, false)).toBe(0);
    expect(gateExitCode(report.verdict, true)).toBe(1);
  });

  it("leaves drift under every threshold as a pass", () => {
    const report = evaluateGate({
      run: run(["steady"]),
      // +30% tokens is under 50, +30% cost under 40, +50% wall under 60.
      results: [result("steady", 1, "pass", { tokens: 1300, costUsd: 1.3, wallMs: 1500 })],
      baselines: new Map([baseline("steady", STEADY)]),
    });
    expect(report.verdict).toBe("pass");
    expect(gateExitCode(report.verdict, true)).toBe(0);
  });

  it("warns rather than fails when a passing case turns flaky", () => {
    const report = evaluateGate({
      run: run(["flaky"]),
      results: [
        result("flaky", 1, "pass", STEADY),
        result("flaky", 2, "fail", STEADY),
      ],
      baselines: new Map([baseline("flaky", STEADY)]),
    });
    expect(report.verdict).toBe("warn");
    expect(report.lines[0]).toContain("newly flaky");
  });

  it("answers N/A with exit 2 when there is no baseline to compare against", () => {
    const report = evaluateGate({
      run: run(["fresh"]),
      results: [result("fresh", 1, "pass", STEADY)],
      baselines: new Map(),
    });
    expect(report.verdict).toBe("not-run");
    expect(report.lines[0]).toContain("no baseline");
    expect(gateExitCode(report.verdict, false)).toBe(2);
    // Strict does not change an absent answer into a wrong one.
    expect(gateExitCode(report.verdict, true)).toBe(2);
  });

  it("lets one real failure outrank every warning in the same run", () => {
    const report = evaluateGate({
      run: run(["drifted", "regressed"]),
      results: [
        result("drifted", 1, "pass", { tokens: 5000, costUsd: 5, wallMs: 5000 }),
        result("regressed", 1, "fail", STEADY),
      ],
      baselines: new Map([baseline("drifted", STEADY), baseline("regressed", STEADY)]),
    });
    expect(report.verdict).toBe("fail");
  });
});
