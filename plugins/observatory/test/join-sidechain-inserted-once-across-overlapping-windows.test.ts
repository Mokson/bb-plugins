// Invariant: each sidechain log row becomes exactly ONE synthetic turn.
//
// Turn windows are padded either side and therefore overlap. Keyed by agent id
// and re-scanned per turn, one subagent's spend was inserted under every turn
// whose window covered it — double counted — while two subagents sharing an
// agent id inside one window collapsed into a single row.
import { describe, expect, it } from "vitest";
import { EventStore } from "../src/core/store-events.js";
import { joinPendingTurns } from "../src/core/join.js";
import { TempDatabase } from "./fakes.js";

const base = {
  provider: "claude-code",
  provider_thread_id: "sess-1",
  model: "claude-sonnet-4.6",
  input: 10,
  reasoning: 0,
  logged_cost_usd: null,
  skill_names: null,
  mcp_names: null,
};

describe("sidechain accounting", () => {
  it("inserts one row per log key even when turn windows overlap", () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      const events = new EventStore(store.db);
      store.upsertThread({
        thread_id: "thr-1",
        provider_id: "claude-code",
        provider_thread_id: "sess-1",
      });
      // Back-to-back turns: the padding makes each window cover both
      // sidechain rows.
      store.upsertTurn({
        thread_id: "thr-1",
        turn_id: "t1",
        started_at: "2026-09-01T10:00:00.000Z",
        completed_at: "2026-09-01T10:00:05.000Z",
        split_source: "unavailable",
      });
      store.upsertTurn({
        thread_id: "thr-1",
        turn_id: "t2",
        started_at: "2026-09-01T10:00:06.000Z",
        completed_at: "2026-09-01T10:00:10.000Z",
        split_source: "unavailable",
      });

      const summary = joinPendingTurns({
        store,
        events,
        logs: {
          listLogTurns: () => [
            // Two DIFFERENT subagent runs that share an agent id.
            {
              ...base,
              log_key: "claude-code:sess-1:1:7",
              ts: Date.parse("2026-09-01T10:00:04.000Z"),
              cache_read: 400,
              cache_write: 20,
              output: 8,
              is_sidechain: 1,
              agent_id: "deliver-qa",
            },
            {
              ...base,
              log_key: "claude-code:sess-1:1:9",
              ts: Date.parse("2026-09-01T10:00:07.000Z"),
              cache_read: 500,
              cache_write: 30,
              output: 9,
              is_sidechain: 1,
              agent_id: "deliver-qa",
            },
          ],
        },
        priceTurn: () => ({
          costUsd: 0.4,
          costSource: "catalog",
          pricingStatus: "exact",
          cacheSavingsUsd: 0.1,
        }),
        catalog: null,
      });

      // Two log rows, two synthetic turns: not four, and not one.
      expect(summary.sidechain).toBe(2);
      const children = store.db
        .prepare(
          "SELECT turn_id, output_tokens, cost_usd FROM obs_turn WHERE split_source = 'sidechain' ORDER BY turn_id",
        )
        .all() as Array<{ turn_id: string; output_tokens: number }>;
      expect(children).toHaveLength(2);
      expect(children.map((row) => row.output_tokens).sort()).toEqual([8, 9]);
      // Each row is attributed once, so the sidechain spend is counted once.
      const total = store.db
        .prepare(
          "SELECT SUM(cost_usd) AS total FROM obs_turn WHERE split_source = 'sidechain'",
        )
        .get() as { total: number };
      expect(total.total).toBeCloseTo(0.8);
    } finally {
      temp.dispose();
    }
  });
});
