// Invariant: a running total that goes backwards is a RESET, never a negative
// turn. Providers zero their counters on compaction, and an unguarded
// subtraction would hand the spend module a negative bill.
import { describe, expect, it } from "vitest";
import { delta, emptyCarry, normalizeEvents } from "../src/core/events.js";
import { event, tokenUsage } from "./fakes.js";

describe("usage reset on compaction", () => {
  it("treats a lower total as a new baseline", () => {
    expect(
      delta(
        { input: 10, cached: 20, output: 5, reasoning: 0 },
        { input: 900, cached: 8_000, output: 400, reasoning: 10 },
      ),
    ).toEqual({ input: 10, cached: 20, output: 5, reasoning: 0 });
  });

  it("never emits a negative turn across a compaction", () => {
    const events = [
      event(1, "turn/started", { providerThreadId: "sess-1" }, { turnId: "t1" }),
      tokenUsage(2, {
        inputTokens: 900,
        cachedInputTokens: 8_000,
        outputTokens: 400,
        reasoningOutputTokens: 10,
      }),
      event(3, "turn/completed", { providerThreadId: "sess-1", status: "completed" }, { turnId: "t1" }),
      event(4, "thread/compacted", { providerThreadId: "sess-1" }),
      event(5, "turn/started", { providerThreadId: "sess-1" }, { turnId: "t2" }),
      tokenUsage(6, {
        inputTokens: 30,
        cachedInputTokens: 120,
        outputTokens: 12,
        reasoningOutputTokens: 0,
      }),
    ];

    const result = normalizeEvents({
      threadId: "thr-1",
      events,
      carry: emptyCarry(),
    });

    const second = result.turns.find((turn) => turn.turn_id === "t2");
    expect(second).toMatchObject({
      input_tokens: 30,
      cached_input_tokens: 120,
      output_tokens: 12,
    });
    for (const turn of result.turns) {
      expect(turn.input_tokens ?? 0).toBeGreaterThanOrEqual(0);
      expect(turn.cached_input_tokens ?? 0).toBeGreaterThanOrEqual(0);
      expect(turn.output_tokens ?? 0).toBeGreaterThanOrEqual(0);
    }
  });
});
