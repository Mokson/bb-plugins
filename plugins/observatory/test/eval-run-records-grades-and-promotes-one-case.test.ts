// The motivating scenario, end to end on a stubbed host: `eval run` cuts a
// worktree at the pinned sha, spawns one hidden thread, answers its question,
// asserts against the ledger the run left behind, records the result, and the
// operator then promotes it so the NEXT run has something to be graded
// against.
//
// It is one test rather than seven because the seam that breaks in practice
// is between the steps: a runner that measures a run nobody can promote, or a
// gate that grades a row the runner never wrote, passes every unit test and
// still leaves the suite useless.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promoteBaseline } from "../src/eval/baseline.js";
import { loadCasesDir } from "../src/eval/cases.js";
import { evaluateGate } from "../src/eval/gate.js";
import { liveRun } from "../src/eval/live.js";
import { EvalStore } from "../src/eval/store.js";
import { caseYaml, git, makeGitFixture, stubRunnerThreads, writeCases } from "./eval-fixtures.js";
import type { GitFixture } from "./eval-fixtures.js";
import { makeHarness } from "./fakes.js";

describe("a live eval run records a case, grades it, and can promote it", () => {
  let fixture: GitFixture;
  beforeEach(() => {
    fixture = makeGitFixture();
  });
  afterEach(() => fixture.dispose());

  it("drives one trial from spawn to a promoted baseline", async () => {
    const host = makeHarness();
    const db = host.bb.storage.database();
    const store = new EvalStore(db);
    const casesDir = writeCases(fixture.root, {
      "e2e": caseYaml("e2e", fixture, { dirty: [] }),
    });

    // The ledger the case asserts on does not exist until the agent writes
    // it, so the stubbed thread writes it as its side effect — the same way a
    // real deliver run would, and into the worktree the runner provisioned.
    const worktreeRoot = join(fixture.root, "trees");
    let ledgerWritten = false;
    stubRunnerThreads(host.harness, {
      statuses: ["active", "idle"],
      interactions: [
        [{ id: "int-1", status: "pending", payload: { kind: "question", title: "Proceed?" } }],
        [],
      ],
      output: "done",
    });
    host.harness.sdk.stub("threads.spawn", () => {
      const specs = join(worktreeRoot, "run-e2e", "e2e-1", "docs", "specs", "OBS-1_thing");
      mkdirSync(specs, { recursive: true });
      writeFileSync(join(specs, "LEDGER.md"), "## runlog\n\n| step |\n");
      ledgerWritten = true;
      return { id: "thr-e2e" };
    });

    const report = await liveRun({
      bb: host.bb,
      db,
      store,
      selected: loadCasesDir(casesDir),
      worktreeRoot,
      artifactsRoot: join(fixture.root, "artifacts"),
      tag: "smoke",
      runId: "run-e2e",
      git,
      // The catch-all rule in the fixture case answers the question. The
      // ledger check is stubbed so this test measures the wiring rather than
      // this machine's copy of check-ledger.sh.
      checkLedgerScript: "/bin/sh",
      run: () => ({ code: 0, stdout: '{"rows":1,"fails":0,"warns":0,"findings":[]}' }),
    });

    expect(ledgerWritten).toBe(true);
    expect(report.outcomes).toHaveLength(1);
    const outcome = report.outcomes[0]!;
    expect(outcome.result.threadId).toBe("thr-e2e");
    expect(outcome.result.assertions?.outcomes.map((entry) => entry.key)).toContain(
      "ledger.exists",
    );
    expect(outcome.result.artifactsDir).toContain("run-e2e");

    // The row is durable, so `eval show` and the gate see the same numbers.
    const stored = store.caseResults("run-e2e");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.thread_id).toBe("thr-e2e");
    expect(store.run("run-e2e")?.finished_at).not.toBeNull();

    // First run of a new case: nothing to compare against, so N/A, not a pass.
    expect(stored[0]?.status).toBe("pass");
    const gate = evaluateGate({
      run: store.run("run-e2e")!,
      results: stored,
      baselines: store.baselines(),
    });
    expect(gate.verdict).toBe("not-run");

    // Promotion is what closes the loop: the next run has a number to be
    // graded against, and only because a person asked for it.
    const promoted = promoteBaseline({
      store,
      runId: "run-e2e",
      promotedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(promoted.promoted).toEqual(["e2e"]);
    expect(store.baselines().get("e2e")?.run_id).toBe("run-e2e");
  });
});
