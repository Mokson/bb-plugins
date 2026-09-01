// Invariant: an upsert writes the columns it was GIVEN and nothing else.
//
// Ingest folds one page of events at a time, so the second page carrying a
// turn is a patch, not a row. A fixed column list turns every absent key into
// an explicit NULL, which makes each page erase what the last one proved: the
// cache split the log join established, the cost, and `started_at`.
import { describe, expect, it } from "vitest";
import { TempDatabase } from "./fakes.js";

describe("partial upsert", () => {
  it("keeps columns a later patch does not mention", () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      store.upsertTurn({
        thread_id: "thr-1",
        turn_id: "t1",
        started_at: "2026-09-01T10:00:00.000Z",
        cache_read_tokens: 900,
        cache_write_tokens: 100,
        cost_usd: 0.42,
        split_source: "log-exact",
      });

      // A second page proves only that the turn finished.
      store.upsertTurn({
        thread_id: "thr-1",
        turn_id: "t1",
        completed_at: "2026-09-01T10:00:10.000Z",
      });

      const turn = store.db
        .prepare("SELECT * FROM obs_turn WHERE turn_id = 't1'")
        .get() as Record<string, unknown>;
      expect(turn).toMatchObject({
        started_at: "2026-09-01T10:00:00.000Z",
        completed_at: "2026-09-01T10:00:10.000Z",
        cache_read_tokens: 900,
        cache_write_tokens: 100,
        cost_usd: 0.42,
        split_source: "log-exact",
      });
    } finally {
      temp.dispose();
    }
  });

  it("never lets a later page downgrade a proven split", () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      store.upsertTurn({
        thread_id: "thr-1",
        turn_id: "t1",
        split_source: "log-exact",
      });
      // Every normalized turn patch carries the "unavailable" default, so an
      // event page touching an already-joined turn must not undo the join.
      store.upsertTurn({
        thread_id: "thr-1",
        turn_id: "t1",
        split_source: "unavailable",
        output_tokens: 50,
      });

      expect(
        store.db
          .prepare("SELECT split_source, output_tokens FROM obs_turn")
          .get(),
      ).toEqual({ split_source: "log-exact", output_tokens: 50 });
    } finally {
      temp.dispose();
    }
  });

  it("keeps an item's started_at when only completion is reported", () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      store.upsertItem({
        item_id: "i1",
        thread_id: "thr-1",
        status: "pending",
        started_at: "2026-09-01T10:00:00.000Z",
        path: "src/a.ts",
      });
      store.upsertItem({
        item_id: "i1",
        thread_id: "thr-1",
        status: "completed",
        completed_at: "2026-09-01T10:00:02.000Z",
      });

      expect(
        store.db
          .prepare(
            "SELECT status, started_at, completed_at, path FROM obs_item WHERE item_id = 'i1'",
          )
          .get(),
      ).toEqual({
        status: "completed",
        started_at: "2026-09-01T10:00:00.000Z",
        completed_at: "2026-09-01T10:00:02.000Z",
        path: "src/a.ts",
      });
    } finally {
      temp.dispose();
    }
  });
});
