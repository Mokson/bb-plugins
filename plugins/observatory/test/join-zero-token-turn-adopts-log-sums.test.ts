// Invariant: when bb reported zero tokens but the log holds the turn's
// requests, the log becomes the turn's token source rather than a refinement
// of it. 369 claude turns reported zero from bb events while 353 of them had
// rows on disk; leaving those at zero understates the bill outright.
import { describe, expect, it } from "vitest";
import { joinPendingTurns } from "../src/core/join.js";
import { JoinHarness, row } from "./join-harness.js";

describe("a turn bb priced at zero", () => {
  it("adopts the log sums as its own tokens", () => {
    const harness = new JoinHarness([
      {
        id: "t1",
        started: "2026-09-01T10:00:00.000Z",
        completed: "2026-09-01T10:00:30.000Z",
        input: 0,
        cached: 0,
        output: 0,
      },
    ]);
    try {
      const rows = [
        row({ key: "a", at: "2026-09-01T10:00:05.000Z", input: 7, output: 3 }),
        row({ key: "b", at: "2026-09-01T10:00:09.000Z", input: 7, output: 4 }),
        row({ key: "c", at: "2026-09-01T10:00:12.000Z", input: 7, output: 5 }),
      ];

      const summary = joinPendingTurns(harness.deps(rows));

      // Zero is not what the log says, so the label is honest about the
      // disagreement even though the numbers are now sound.
      expect(summary).toMatchObject({ logWindow: 1, logExact: 0 });
      expect(harness.turnRow("t1")).toMatchObject({
        input_tokens: 21,
        cached_input_tokens: 330,
        output_tokens: 12,
        cache_read_tokens: 300,
        cache_write_tokens: 30,
        split_source: "log-window",
      });
      expect(harness.stats().turns["t1"]?.tokenSource).toBe("log");
    } finally {
      harness.dispose();
    }
  });

  it("leaves a turn bb DID price alone", () => {
    const harness = new JoinHarness([
      {
        id: "t1",
        started: "2026-09-01T10:00:00.000Z",
        completed: "2026-09-01T10:00:30.000Z",
        input: 55,
        cached: 110,
        output: 5,
      },
    ]);
    try {
      joinPendingTurns(
        harness.deps([row({ key: "a", at: "2026-09-01T10:00:05.000Z" })]),
      );
      expect(harness.turnRow("t1")).toMatchObject({ input_tokens: 55 });
      expect(harness.stats().turns["t1"]?.tokenSource).toBe("bb");
    } finally {
      harness.dispose();
    }
  });
});
