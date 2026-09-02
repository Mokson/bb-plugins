// Invariant: `log-window` is a PROVISIONAL verdict, not a terminal one.
//
// A turn is joined within a minute of completing, while bb's own usage event
// is still catching up with the requests the provider log already recorded.
// The first comparison therefore fails and the turn is labelled `log-window`
// - and while the pending queue excluded that state, the premature verdict
// was frozen forever. On the live ledger 340 of 393 `log-window` claude-code
// turns held sums that already agreed with bb by the time anyone looked.
//
// The rows below are one real claude-code turn, anonymized: only the session
// and turn ids are replaced, the timings are relative to the same second
// offsets, and the token counts are the ones the log actually carried.
import { describe, expect, it } from "vitest";
import { joinPendingTurns } from "../src/core/join.js";
import { JoinHarness, row } from "./join-harness.js";

const START = "2026-08-30T20:39:17.443Z";
const COMPLETED = "2026-08-30T20:43:48.613Z";

/** (cacheRead, cacheWrite, output) per request, in log order. */
const REQUESTS: Array<[string, number, number, number]> = [
  ["2026-08-30T20:39:19.440Z", 52_048, 558, 120],
  ["2026-08-30T20:39:23.367Z", 52_606, 275, 73],
  ["2026-08-30T20:39:25.874Z", 52_881, 191, 93],
  ["2026-08-30T20:39:27.889Z", 53_072, 234, 95],
  ["2026-08-30T20:39:33.592Z", 53_306, 1_267, 308],
  ["2026-08-30T20:39:43.333Z", 54_573, 2_127, 643],
];

const SETTLED_CACHED = REQUESTS.reduce((sum, [, read, write]) => sum + read + write, 0);
const SETTLED_OUTPUT = REQUESTS.reduce((sum, [, , , output]) => sum + output, 0);

describe("a turn joined before bb's totals settled", () => {
  it("is retried, and becomes log-exact once they agree", () => {
    const harness = new JoinHarness([
      {
        id: "t1",
        started: START,
        completed: COMPLETED,
        // What bb had reported when the join first ran: the first request
        // only. The log already held all six.
        cached: REQUESTS[0]![1] + REQUESTS[0]![2],
        output: REQUESTS[0]![3],
      },
    ]);
    try {
      const rows = REQUESTS.map(([at, cacheRead, cacheWrite, output], index) =>
        row({ key: `r${index}`, at, cacheRead, cacheWrite, output }),
      );
      const deps = harness.deps(rows);

      expect(joinPendingTurns(deps)).toMatchObject({ logWindow: 1, logExact: 0 });
      expect(harness.turnRow("t1")["split_source"]).toBe("log-window");

      // bb's usage event catches up with the same six requests.
      harness.store.upsertTurn({
        thread_id: "thr-1",
        turn_id: "t1",
        cached_input_tokens: SETTLED_CACHED,
        output_tokens: SETTLED_OUTPUT,
      });

      expect(joinPendingTurns(deps)).toMatchObject({ logExact: 1 });
      const settled = harness.turnRow("t1");
      expect(settled["split_source"]).toBe("log-exact");
      // The split itself never moved: the partition was right the first time,
      // only the thing it was compared against was still in motion.
      expect(
        (settled["cache_read_tokens"] as number) +
          (settled["cache_write_tokens"] as number),
      ).toBe(SETTLED_CACHED);
    } finally {
      harness.dispose();
    }
  });

  it("stops retrying a log-window turn older than the settle window", () => {
    const harness = new JoinHarness([
      {
        id: "t1",
        started: START,
        completed: COMPLETED,
        cached: 1,
        output: 1,
        split: "log-window",
      },
    ]);
    try {
      // A cutoff after the turn's start: nothing about a day-old turn is
      // still moving, and re-reading it every five minutes forever would put
      // the whole back catalogue in the scheduled pass.
      expect(
        harness.events.listTurnsPendingSplit(500, "2026-08-31T00:00:00.000Z"),
      ).toEqual([]);
      expect(
        harness.events
          .listTurnsPendingSplit(500, "2026-08-30T00:00:00.000Z")
          .map((turn) => turn.turn_id),
      ).toEqual(["t1"]);
    } finally {
      harness.dispose();
    }
  });
});
