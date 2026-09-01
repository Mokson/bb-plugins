// The runner, gate and baseline are declared but not built. Each must REFUSE.
// A seam that returned a plausible empty result would let `eval run --gate`
// report a pass on a stack nothing ever exercised — the exact lie this whole
// module exists to prevent.
import { describe, expect, it } from "vitest";
import { promoteBaseline } from "../src/eval/baseline.js";
import { evaluateGate } from "../src/eval/gate.js";
import { NotImplementedError, runCase } from "../src/eval/runner.js";
import { EvalStore } from "../src/eval/store.js";
import { TempDatabase } from "./fakes.js";

describe("the part 2 seams refuse rather than fake a result", () => {
  it("rejects runCase", async () => {
    await expect(
      runCase({} as unknown as Parameters<typeof runCase>[0]),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  it("throws from the gate", () => {
    expect(() => evaluateGate({} as unknown as Parameters<typeof evaluateGate>[0])).toThrow(
      NotImplementedError,
    );
  });

  it("throws from baseline promotion, leaving eval_baseline untouched", () => {
    const temp = new TempDatabase();
    try {
      const store = new EvalStore(temp.openDatabase());
      expect(() =>
        promoteBaseline({ store, runId: "run-1", promotedAt: "2026-09-01T00:00:00.000Z" }),
      ).toThrow(NotImplementedError);
      expect(store.baselines().size).toBe(0);
    } finally {
      temp.dispose();
    }
  });
});
