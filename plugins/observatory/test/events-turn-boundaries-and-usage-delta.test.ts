// Invariant: a turn's tokens are its SHARE of the thread's running total, and
// its boundaries come from turn/started and turn/completed. bb reports totals,
// so a normalizer that stored them verbatim would bill every turn for the
// whole thread.
import { describe, expect, it } from "vitest";
import { emptyCarry, normalizeEvents } from "../src/core/events.js";
import { event, tokenUsage } from "./fakes.js";

describe("turn boundaries and usage delta", () => {
  it("gives each turn only the tokens added during it", () => {
    const events = [
      event(1, "turn/started", { providerThreadId: "sess-1" }, { turnId: "t1" }),
      tokenUsage(2, {
        inputTokens: 100,
        cachedInputTokens: 1_000,
        outputTokens: 50,
        reasoningOutputTokens: 10,
      }),
      event(3, "turn/completed", { providerThreadId: "sess-1", status: "completed" }, { turnId: "t1" }),
      event(4, "turn/started", { providerThreadId: "sess-1" }, { turnId: "t2" }),
      tokenUsage(5, {
        inputTokens: 180,
        cachedInputTokens: 3_000,
        outputTokens: 90,
        reasoningOutputTokens: 30,
      }),
      event(6, "turn/completed", { providerThreadId: "sess-1", status: "completed" }, { turnId: "t2" }),
    ];

    const result = normalizeEvents({
      threadId: "thr-1",
      events,
      carry: emptyCarry(),
    });

    const byId = new Map(result.turns.map((turn) => [turn.turn_id, turn]));
    expect(byId.get("t1")).toMatchObject({
      seq_started: 1,
      seq_completed: 3,
      input_tokens: 100,
      cached_input_tokens: 1_000,
      output_tokens: 50,
    });
    expect(byId.get("t2")).toMatchObject({
      seq_started: 4,
      seq_completed: 6,
      input_tokens: 80,
      cached_input_tokens: 2_000,
      output_tokens: 40,
      reasoning_tokens: 20,
    });
    expect(result.lastSeq).toBe(6);
  });
});
