// PRODUCT.md invariant 1: the plugin never stops a thread it did not spawn.
//
// The guard reads OWNERSHIP FROM THE DATABASE rather than from a set held in
// memory, which is what makes this test meaningful across processes: an
// `eval cancel` running minutes after the runner exited is bound by the same
// record. A thread nobody recorded is refused loudly, and `threads.stop` is
// never reached — an exception after the kill would be no protection at all.
import { describe, expect, it } from "vitest";
import { ForeignThreadError, stopOwnedThread } from "../src/eval/runner.js";
import { EvalStore } from "../src/eval/store.js";
import { stubRunnerThreads } from "./eval-fixtures.js";
import { makeHarness } from "./fakes.js";

describe("the eval runner never stops a thread it did not spawn", () => {
  it("refuses an unrecorded thread id without calling threads.stop", async () => {
    const host = makeHarness();
    const store = new EvalStore(host.bb.storage.database());
    const state = stubRunnerThreads(host.harness);

    await expect(
      stopOwnedThread(host.bb, store, "thr-belongs-to-a-person"),
    ).rejects.toBeInstanceOf(ForeignThreadError);
    expect(state.stopped).toEqual([]);
    expect(host.harness.sdk.callsTo("threads.stop")).toEqual([]);
  });

  it("stops a thread that a run recorded as its own", async () => {
    const host = makeHarness();
    const store = new EvalStore(host.bb.storage.database());
    const state = stubRunnerThreads(host.harness);
    store.upsertCaseResult({
      run_id: "run-1",
      case: "mine",
      trial: 1,
      status: "running",
      assertions_json: null,
      metrics_json: null,
      thread_id: "thr-mine",
      artifacts_dir: null,
    });

    await stopOwnedThread(host.bb, store, "thr-mine");
    expect(state.stopped).toEqual(["thr-mine"]);
  });
});
