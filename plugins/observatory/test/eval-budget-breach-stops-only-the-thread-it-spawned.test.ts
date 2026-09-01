// A case over its cost ceiling is killed — and NOTHING else is.
//
// The ledger in this test holds two thread trees: the one the runner spawned,
// well over budget, and a neighbour that is also over budget and belongs to
// somebody else. A breach check that summed the wrong rows, or a stop that
// took an id from the ledger rather than from its own spawn, would kill the
// neighbour. That is the failure PRODUCT.md invariant 1 forbids.
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

describe("a budget breach stops only the thread the runner spawned", () => {
  let fixture: GitFixture;
  beforeEach(() => {
    fixture = makeGitFixture();
  });
  afterEach(() => fixture.dispose());

  it("kills the eval thread on cost and leaves the neighbour alone", async () => {
    const host = makeHarness();
    const db = host.bb.storage.database();
    const store = new EvalStore(db);

    // The case's ceiling is 8 usd. The eval tree bills 9 across a subagent,
    // so the breach is only visible to a check that follows root_thread_id.
    const insert = db.prepare(
      `INSERT INTO obs_turn (thread_id, turn_id, root_thread_id, cost_usd, output_tokens)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run("thr-eval", "t1", "thr-eval", 1, 10);
    insert.run("thr-eval-child", "t2", "thr-eval", 8, 10);
    insert.run("thr-neighbour", "t1", "thr-neighbour", 99, 10);

    const dir = writeCases(fixture.root, { "spendy": caseYaml("spendy", fixture) });
    const value = loadCaseFile(join(dir, "spendy.yaml")).value;
    const worktree = join(fixture.root, "wt");
    mkdirSync(worktree, { recursive: true });
    const state = stubRunnerThreads(host.harness, { statuses: ["active"] });

    const result = await runCase({
      bb: host.bb,
      db,
      store,
      runId: "run-budget",
      case: value!,
      trial: 1,
      worktree,
      spawn: buildSpawnPlan(value!, worktree, 1, "run-budget"),
      artifactsRoot: join(fixture.root, "artifacts"),
      stackShaAtStart: null,
      run: () => ({ code: 0, stdout: '{"rows":0,"fails":0,"warns":0,"findings":[]}' }),
    });

    expect(result.failReason).toBe("budget");
    expect(result.detail).toContain("over the 8 ceiling");
    expect(state.stopped).toEqual(["thr-eval"]);
    expect(state.stopped).not.toContain("thr-neighbour");
    // The partial evidence survives the kill: that is when it matters most.
    expect(result.artifactsDir).not.toBeNull();
  });
});
