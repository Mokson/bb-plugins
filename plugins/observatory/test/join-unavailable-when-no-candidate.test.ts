// Invariant: no log row means NULL cache columns and `unavailable`. The retro
// rule is explicit — `unattributed` beats a fabricated $0.00, and a plausible
// split would be indistinguishable from a proven one downstream.
import { describe, expect, it } from "vitest";
import { EventStore } from "../src/core/store-events.js";
import { joinPendingTurns } from "../src/core/join.js";
import { TempDatabase } from "./fakes.js";

describe("no candidate", () => {
  it("leaves the split unavailable and the cache columns null", () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      const events = new EventStore(store.db);
      store.upsertThread({
        thread_id: "thr-1",
        provider_id: "acp-cursor",
        provider_thread_id: "sess-9",
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
        logs: { listLogTurns: () => [] },
        priceTurn: () => ({
          costUsd: null,
          costSource: null,
          pricingStatus: "unknown",
          cacheSavingsUsd: null,
        }),
        catalog: null,
      });

      expect(summary).toMatchObject({ unavailable: 1, logExact: 0, logWindow: 0 });
      const row = store.db
        .prepare("SELECT * FROM obs_turn WHERE turn_id = 't1'")
        .get() as Record<string, unknown>;
      expect(row.cache_read_tokens).toBeNull();
      expect(row.cache_write_tokens).toBeNull();
      expect(row.split_source).toBe("unavailable");
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM obs_match").get()).toEqual({
        n: 0,
      });
    } finally {
      temp.dispose();
    }
  });
});
