// Invariant: a deliver seat that ran as an in-session subagent gets its own
// row. Those seats never became bb threads, so folding their spend into the
// parent turn would hide the exact per-seat number the ledger exists for.
import { describe, expect, it } from "vitest";
import { EventStore } from "../src/core/store-events.js";
import { joinPendingTurns, sidechainTurnId } from "../src/core/join.js";
import { TempDatabase } from "./fakes.js";

describe("sidechain rows", () => {
  it("becomes a synthetic child turn keyed by its agent", () => {
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
      const summary = joinPendingTurns({
        store,
        events,
        logs: {
          listLogTurns: () => [
            {
              ...base,
              log_key: "claude-code:sess-1:1:1",
              ts: Date.parse("2026-09-01T10:00:05.000Z"),
              cache_read: 900,
              cache_write: 100,
              output: 50,
              is_sidechain: 0,
              agent_id: null,
            },
            {
              ...base,
              log_key: "claude-code:sess-1:1:7",
              ts: Date.parse("2026-09-01T10:00:06.000Z"),
              cache_read: 400,
              cache_write: 20,
              output: 8,
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

      expect(summary.sidechain).toBe(1);
      const child = store.db
        .prepare("SELECT * FROM obs_turn WHERE turn_id = ?")
        .get(sidechainTurnId("t1", "deliver-qa")) as Record<string, unknown>;
      expect(child).toMatchObject({
        thread_id: "thr-1",
        split_source: "sidechain",
        cache_read_tokens: 400,
        cache_write_tokens: 20,
        output_tokens: 8,
      });
      // The parent keeps its own proven split; the child is additional.
      const parent = store.db
        .prepare("SELECT split_source FROM obs_turn WHERE turn_id = 't1'")
        .get();
      expect(parent).toEqual({ split_source: "log-exact" });
    } finally {
      temp.dispose();
    }
  });
});
