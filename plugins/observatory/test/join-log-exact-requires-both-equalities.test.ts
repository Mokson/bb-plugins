// Invariant: `log-exact` needs BOTH the cache total and the output tokens to
// agree. Inside one session these numbers repeat often enough that a single
// agreement is a coincidence, and a wrong split silently misprices the turn.
import { describe, expect, it } from "vitest";
import { EventStore } from "../src/core/store-events.js";
import { isExactMatch, joinPendingTurns, type LogTurn } from "../src/core/join.js";
import { TempDatabase } from "./fakes.js";

function logTurn(overrides: Partial<LogTurn>): LogTurn {
  return {
    log_key: "claude-code:sess-1:1:1",
    provider: "claude-code",
    provider_thread_id: "sess-1",
    ts: Date.parse("2026-09-01T10:00:05.000Z"),
    model: "claude-opus-5",
    input: 100,
    cache_read: 900,
    cache_write: 100,
    output: 50,
    reasoning: 0,
    logged_cost_usd: null,
    is_sidechain: 0,
    agent_id: null,
    skill_names: null,
    mcp_names: null,
    ...overrides,
  };
}

const priced = {
  costUsd: 1.5,
  costSource: "catalog",
  pricingStatus: "exact",
  cacheSavingsUsd: 0.2,
};

describe("log-exact", () => {
  it("requires the cache total and the output to both agree", () => {
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
    expect(isExactMatch(turn, logTurn({}))).toBe(true);
    expect(isExactMatch(turn, logTurn({ output: 51 }))).toBe(false);
    expect(isExactMatch(turn, logTurn({ cache_read: 800 }))).toBe(false);
  });

  it("writes the proven split and its match row", () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      const events = new EventStore(store.db);
      store.upsertThread({
        thread_id: "thr-1",
        provider_id: "claude-code",
        provider_thread_id: "sess-1",
      });
      store.upsertTurn({
        thread_id: "thr-1",
        turn_id: "t1",
        started_at: "2026-09-01T10:00:00.000Z",
        completed_at: "2026-09-01T10:00:10.000Z",
        cached_input_tokens: 1_000,
        output_tokens: 50,
        split_source: "unavailable",
      });

      const summary = joinPendingTurns({
        store,
        events,
        logs: { listLogTurns: () => [logTurn({})] },
        priceTurn: () => priced,
        catalog: null,
      });

      expect(summary.logExact).toBe(1);
      const row = store.db
        .prepare("SELECT * FROM obs_turn WHERE turn_id = 't1'")
        .get() as Record<string, unknown>;
      expect(row).toMatchObject({
        cache_read_tokens: 900,
        cache_write_tokens: 100,
        model_reported: "claude-opus-5",
        split_source: "log-exact",
        cost_usd: 1.5,
      });
      expect(
        store.db.prepare("SELECT method FROM obs_match").get(),
      ).toEqual({ method: "log-exact" });
    } finally {
      temp.dispose();
    }
  });
});
