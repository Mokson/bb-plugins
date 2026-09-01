// Invariant: a usage total flushed after `turn/completed` belongs to the turn
// that just finished.
//
// Providers report the final token total AFTER closing the turn. Dropping that
// event still advanced the running baseline, so the tokens were not merely
// lost — they were silently donated to whichever turn opened next.
import { describe, expect, it } from "vitest";
import { emptyCarry, normalizeEvents } from "../src/core/events.js";
import { event, tokenUsage } from "./fakes.js";

describe("trailing usage", () => {
  it("attributes post-completion usage to the completed turn", () => {
    const result = normalizeEvents({
      threadId: "thr-1",
      carry: emptyCarry(),
      events: [
        event(1, "turn/started", { providerThreadId: "sess-1" }, { turnId: "t1" }),
        event(
          2,
          "turn/completed",
          { providerThreadId: "sess-1", status: "completed" },
          { turnId: "t1" },
        ),
        // Thread-scoped: no turn is open by the time it arrives.
        tokenUsage(3, {
          inputTokens: 100,
          cachedInputTokens: 1_000,
          outputTokens: 50,
          reasoningOutputTokens: 10,
        }),
      ],
    });

    const byId = new Map(result.turns.map((turn) => [turn.turn_id, turn]));
    expect(byId.get("t1")).toMatchObject({
      input_tokens: 100,
      cached_input_tokens: 1_000,
      output_tokens: 50,
      reasoning_tokens: 10,
    });
  });

  it("stops crediting the finished turn once the next one starts", () => {
    const result = normalizeEvents({
      threadId: "thr-1",
      carry: emptyCarry(),
      events: [
        event(1, "turn/started", { providerThreadId: "sess-1" }, { turnId: "t1" }),
        event(
          2,
          "turn/completed",
          { providerThreadId: "sess-1", status: "completed" },
          { turnId: "t1" },
        ),
        tokenUsage(3, {
          inputTokens: 100,
          cachedInputTokens: 1_000,
          outputTokens: 50,
          reasoningOutputTokens: 10,
        }),
        event(4, "turn/started", { providerThreadId: "sess-1" }, { turnId: "t2" }),
        tokenUsage(5, {
          inputTokens: 180,
          cachedInputTokens: 3_000,
          outputTokens: 90,
          reasoningOutputTokens: 30,
        }),
      ],
    });

    const byId = new Map(result.turns.map((turn) => [turn.turn_id, turn]));
    expect(byId.get("t1")).toMatchObject({ input_tokens: 100 });
    expect(byId.get("t2")).toMatchObject({
      input_tokens: 80,
      cached_input_tokens: 2_000,
      output_tokens: 40,
    });
  });
});
