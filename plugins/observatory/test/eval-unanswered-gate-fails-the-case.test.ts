// A question no `answers[]` rule covers is a FAILURE, not a wait.
//
// PRODUCT.md invariant 30's whole point: an eval that blocks on a human has
// measured nothing, and it goes on being billed while it waits. So the runner
// stops the thread it spawned and reports `unanswered-gate` with the question
// it could not answer, which is the one thing an operator needs to fix the
// case file.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCaseFile } from "../src/eval/cases.js";
import { buildSpawnPlan } from "../src/eval/dryrun.js";
import { runCase } from "../src/eval/runner.js";
import { EvalStore } from "../src/eval/store.js";
import { caseYaml, makeGitFixture, stubRunnerThreads, writeCases } from "./eval-fixtures.js";
import type { GitFixture } from "./eval-fixtures.js";
import { makeHarness } from "./fakes.js";

describe("an unanswered gate fails the case", () => {
  let fixture: GitFixture;
  beforeEach(() => {
    fixture = makeGitFixture();
  });
  afterEach(() => fixture.dispose());

  it("stops the thread and reports the question nothing matched", async () => {
    const host = makeHarness();
    const db = host.bb.storage.database();
    const store = new EvalStore(db);
    // The only rule answers permission prompts, so a plain question is
    // uncovered — the realistic shape of this bug, not a case with no rules.
    const dir = writeCases(fixture.root, {
      "gated": caseYaml("gated", fixture, {
        answers: [
          "  - match: { kind: permission }",
          '    respond: "allow"',
          "    default: { max_uses: 3 }",
        ],
      }),
    });
    const value = loadCaseFile(join(dir, "gated.yaml")).value;
    expect(value).not.toBeNull();

    const worktree = join(fixture.root, "wt");
    mkdirSync(worktree, { recursive: true });
    const state = stubRunnerThreads(host.harness, {
      statuses: ["active"],
      interactions: [
        [
          {
            id: "int-1",
            status: "pending",
            payload: { kind: "question", title: "Which option should I take?" },
          },
        ],
      ],
    });

    const result = await runCase({
      bb: host.bb,
      db,
      store,
      runId: "run-gate",
      case: value!,
      trial: 1,
      worktree,
      spawn: buildSpawnPlan(value!, worktree, 1, "run-gate"),
      artifactsRoot: join(fixture.root, "artifacts"),
      stackShaAtStart: null,
      run: () => ({ code: 0, stdout: '{"rows":0,"fails":0,"warns":0,"findings":[]}' }),
    });

    expect(result.status).toBe("fail");
    expect(result.failReason).toBe("unanswered-gate");
    expect(result.detail).toContain("Which option should I take?");
    expect(state.stopped).toEqual(["thr-eval"]);
    // Nothing was answered: a rule that does not match must not be stretched
    // to cover a question it was not written for.
    expect(state.answered).toEqual([]);
  });
});
