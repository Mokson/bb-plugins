// Invariant: a reset plus a re-drain reproduces the ledger exactly.
//
// `--reset` exists because a plain backfill resumes from the watermark, so a
// column the normalizer only learned to keep AFTER a thread was drained stays
// empty forever. That is only safe if re-reading the whole history is
// idempotent: the watermark and the carry have to be cleared TOGETHER, or the
// second pass folds a stale carry into events it is about to read again and
// every per-turn total comes out doubled.
import { describe, expect, it } from "vitest";
import { createIngest } from "../src/core/ingest.js";
import { EventStore } from "../src/core/store-events.js";
import { TempDatabase, event, makeIngestHost, tokenUsage } from "./fakes.js";

describe("backfill reset", () => {
  it("re-derives the same turn totals it had after the first drain", async () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      const events = new EventStore(store.db);
      const host = makeIngestHost();
      host.threads.set("thr-1", { id: "thr-1", title: "[son5:low] slice" });
      host.pages.set("thr-1", [
        event(1, "thread/identity", { providerThreadId: "sess-1" }),
        event(2, "turn/started", { providerThreadId: "sess-1" }, { turnId: "t1" }),
        tokenUsage(3, {
          inputTokens: 100,
          cachedInputTokens: 1_000,
          outputTokens: 50,
          reasoningOutputTokens: 10,
        }),
        event(
          4,
          "turn/completed",
          { providerThreadId: "sess-1", status: "completed" },
          { turnId: "t1" },
        ),
        event(5, "turn/started", { providerThreadId: "sess-1" }, { turnId: "t2" }),
        tokenUsage(6, {
          inputTokens: 180,
          cachedInputTokens: 3_000,
          outputTokens: 90,
          reasoningOutputTokens: 30,
        }),
        event(
          7,
          "turn/completed",
          { providerThreadId: "sess-1", status: "completed" },
          { turnId: "t2" },
        ),
      ]);

      const ingest = createIngest({ bb: host.bb, store, events });
      await ingest.drainThread("thr-1");
      const readTurns = () =>
        store.db
          .prepare("SELECT * FROM obs_turn ORDER BY turn_id")
          .all() as Array<Record<string, unknown>>;
      const first = readTurns();
      expect(first).toHaveLength(2);
      expect(first[0]).toMatchObject({
        turn_id: "t1",
        input_tokens: 100,
        cached_input_tokens: 1_000,
      });
      expect(first[1]).toMatchObject({
        turn_id: "t2",
        input_tokens: 80,
        cached_input_tokens: 2_000,
      });

      ingest.reset(["thr-1"]);
      // The rewind is what makes the re-read possible at all.
      expect(events.watermark("thr-1")).toBeNull();

      await ingest.drainThread("thr-1");

      expect(readTurns()).toEqual(first);
      expect(events.watermark("thr-1")).toBe(7);
      // The identity the first drain proved is re-proved, not lost.
      expect(
        store.db.prepare("SELECT provider_thread_id FROM obs_thread").get(),
      ).toEqual({ provider_thread_id: "sess-1" });
    } finally {
      temp.dispose();
    }
  });
});
