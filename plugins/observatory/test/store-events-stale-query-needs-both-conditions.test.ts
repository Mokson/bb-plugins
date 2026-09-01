// Invariant: a thread is stale only when it is BOTH live and old.
//
// SQL binds AND tighter than OR, so an unparenthesised
// `status IS NULL OR status NOT IN (...) AND last_seen_at < ?` re-queued every
// freshly drained thread on status alone, and the reconcile pass rewrote the
// whole ledger on every cycle.
import { describe, expect, it } from "vitest";
import { EventStore } from "../src/core/store-events.js";
import { TempDatabase } from "./fakes.js";

describe("stale thread query", () => {
  it("does not requeue a thread that was just drained", () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      const events = new EventStore(store.db);
      store.upsertThread({
        thread_id: "fresh",
        status: "idle",
        last_seen_at: "2026-09-01T12:00:00.000Z",
      });
      store.upsertThread({
        thread_id: "old",
        status: "idle",
        last_seen_at: "2026-09-01T09:00:00.000Z",
      });
      store.upsertThread({
        thread_id: "archived-and-old",
        status: "archived",
        last_seen_at: "2026-09-01T09:00:00.000Z",
      });

      const stale = events
        .listStaleThreads("2026-09-01T11:00:00.000Z")
        .map((row) => row.thread_id);

      expect(stale).toEqual(["old"]);
    } finally {
      temp.dispose();
    }
  });
});
