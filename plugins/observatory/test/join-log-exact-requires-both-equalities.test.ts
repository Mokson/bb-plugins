// Invariant: `log-exact` needs BOTH the cache total and the output to agree
// with bb's own totals. The attribution no longer depends on it (the slice is
// the turn's spend either way), but the LABEL does: `log-exact` is what tells
// a reader the two independent clocks saw the same requests, and a one-sided
// agreement is a coincidence at the rate these numbers repeat.
import { describe, expect, it } from "vitest";
import { isExactMatch, joinPendingTurns, sumRows } from "../src/core/join.js";
import { JoinHarness, row } from "./join-harness.js";

const turn = {
  thread_id: "thr-1",
  turn_id: "t1",
  provider_id: "claude-code",
  provider_thread_id: "sess-1",
  started_at: "2026-09-01T10:00:00.000Z",
  completed_at: "2026-09-01T10:00:10.000Z",
  cached_input_tokens: 1_000,
  output_tokens: 50,
  input_tokens: 100,
  reasoning_tokens: 0,
  model_requested: null,
  split_source: "unavailable" as const,
};

describe("log-exact", () => {
  it("requires the cache total and the output to both agree", () => {
    const base = { key: "a", at: turn.started_at, cacheRead: 900, cacheWrite: 100, output: 50 };
    expect(isExactMatch(turn, sumRows([row(base)]))).toBe(true);
    expect(isExactMatch(turn, sumRows([row({ ...base, output: 51 })]))).toBe(false);
    expect(isExactMatch(turn, sumRows([row({ ...base, cacheRead: 800 })]))).toBe(false);
  });

  it("holds across a slice, not just a single row", () => {
    expect(
      isExactMatch(
        turn,
        sumRows([
          row({ key: "a", at: turn.started_at, cacheRead: 500, cacheWrite: 60, output: 20 }),
          row({ key: "b", at: turn.started_at, cacheRead: 400, cacheWrite: 40, output: 30 }),
        ]),
      ),
    ).toBe(true);
  });

  it("writes the proven split and its match row", () => {
    const harness = new JoinHarness([
      {
        id: "t1",
        started: "2026-09-01T10:00:00.000Z",
        completed: "2026-09-01T10:00:10.000Z",
        input: 100,
        cached: 1_000,
        output: 50,
      },
    ]);
    try {
      const summary = joinPendingTurns(
        harness.deps(
          [
            row({
              key: "a",
              at: "2026-09-01T10:00:05.000Z",
              cacheRead: 900,
              cacheWrite: 100,
              output: 50,
            }),
          ],
          () => ({
            costUsd: 1.5,
            costSource: "catalog",
            pricingStatus: "exact",
            cacheSavingsUsd: 0.2,
          }),
        ),
      );

      expect(summary.logExact).toBe(1);
      expect(harness.turnRow("t1")).toMatchObject({
        cache_read_tokens: 900,
        cache_write_tokens: 100,
        model_reported: "claude-opus-5",
        split_source: "log-exact",
        cost_usd: 1.5,
      });
      expect(harness.matchRows()).toEqual([
        expect.objectContaining({ method: "partition", confidence: 1 }),
      ]);
    } finally {
      harness.dispose();
    }
  });
});
