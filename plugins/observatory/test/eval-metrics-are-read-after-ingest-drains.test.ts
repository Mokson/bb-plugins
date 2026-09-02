// A trial reported 8 tool calls, 0 tokens and 0.00 usd.
//
// Ingest drains on a background loop, so when the runner's loop breaks the
// turn that ended the trial is still in core's dirty set: the item rows have
// landed (hence the tool calls) but the turn's usage has not. The runner now
// awaits the drain before its harvest read, and this pins that ordering by
// writing the usage FROM the drain hook.
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

describe("eval metrics are read after ingest drains", () => {
  let fixture: GitFixture;
  beforeEach(() => {
    fixture = makeGitFixture();
  });
  afterEach(() => fixture.dispose());

  it("reports the tokens the drain wrote, not the zeros before it", async () => {
    const host = makeHarness();
    const db = host.bb.storage.database();
    const store = new EvalStore(db);

    // The undrained ledger: a turn with its tool calls and no usage at all.
    db.prepare(
      `INSERT INTO obs_turn (thread_id, turn_id, root_thread_id, tool_calls)
       VALUES ('thr-eval', 't1', 'thr-eval', 8)`,
    ).run();

    const dir = writeCases(fixture.root, { "spendy": caseYaml("spendy", fixture) });
    const value = loadCaseFile(join(dir, "spendy.yaml")).value;
    const worktree = join(fixture.root, "wt");
    mkdirSync(worktree, { recursive: true });
    stubRunnerThreads(host.harness, { statuses: ["idle"] });

    const drained: string[] = [];
    const result = await runCase({
      bb: host.bb,
      db,
      store,
      runId: "run-drain",
      case: value!,
      trial: 1,
      worktree,
      spawn: buildSpawnPlan(value!, worktree, 1, "run-drain"),
      artifactsRoot: join(fixture.root, "artifacts"),
      stackShaAtStart: null,
      drainThread: (threadId) => {
        drained.push(threadId);
        db.prepare(
          `UPDATE obs_turn SET output_tokens = 1738, cost_usd = 0.22
            WHERE thread_id = 'thr-eval'`,
        ).run();
        return Promise.resolve(1);
      },
      run: () => ({ code: 0, stdout: '{"rows":0,"fails":0,"warns":0,"findings":[]}' }),
    });

    expect(drained).toEqual(["thr-eval"]);
    expect(result.metrics.toolCalls).toBe(8);
    expect(result.metrics.tokens).toBe(1738);
    expect(result.metrics.costUsd).toBeCloseTo(0.22, 5);
  });

  it("still reports metrics when the drain throws", async () => {
    const host = makeHarness();
    const db = host.bb.storage.database();
    const store = new EvalStore(db);
    db.prepare(
      `INSERT INTO obs_turn (thread_id, turn_id, root_thread_id, tool_calls)
       VALUES ('thr-eval', 't1', 'thr-eval', 3)`,
    ).run();

    const dir = writeCases(fixture.root, { "spendy": caseYaml("spendy", fixture) });
    const value = loadCaseFile(join(dir, "spendy.yaml")).value;
    const worktree = join(fixture.root, "wt");
    mkdirSync(worktree, { recursive: true });
    stubRunnerThreads(host.harness, { statuses: ["idle"] });

    const result = await runCase({
      bb: host.bb,
      db,
      store,
      runId: "run-drain-fails",
      case: value!,
      trial: 1,
      worktree,
      spawn: buildSpawnPlan(value!, worktree, 1, "run-drain-fails"),
      artifactsRoot: join(fixture.root, "artifacts"),
      stackShaAtStart: null,
      drainThread: () => Promise.reject(new Error("core is down")),
      run: () => ({ code: 0, stdout: '{"rows":0,"fails":0,"warns":0,"findings":[]}' }),
    });

    // As stale as it was before, never a failed trial.
    expect(result.metrics.toolCalls).toBe(3);
  });
});
