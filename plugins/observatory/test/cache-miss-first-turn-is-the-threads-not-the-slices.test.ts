// `first-turn` is a claim about the THREAD, and a range query only ever loads
// a slice of it.
//
// A 7d scan of a month-old thread starts mid-conversation. Reading the first
// row of that slice as the thread's first turn labels an ordinary mid-thread
// miss `first-turn`, and because the cause is written into a deduped signal,
// no later scan can correct it: the wrong cause is frozen for good.
import { afterEach, describe, expect, it } from "vitest";
import { detectCacheMisses } from "../src/spend/cache-miss.js";
import { TempDatabase } from "./fakes.js";
import { seedThread, seedTurn, testCatalog } from "./spend-fixtures.js";

const NOW = Date.parse("2026-08-31T00:00:00.000Z");

/** Three turns: an old one, then a big read, then the drop the scan finds. */
function seedThreeTurnThread(store: ReturnType<TempDatabase["open"]>): void {
  seedThread(store, { thread_id: "root" });
  seedTurn(store, {
    thread_id: "root",
    turn_id: "t1",
    started_at: "2026-08-20T10:00:00.000Z",
    cache_read_tokens: 100_000,
    model_reported: "test-model",
  });
  seedTurn(store, {
    thread_id: "root",
    turn_id: "t2",
    started_at: "2026-08-30T10:00:00.000Z",
    cache_read_tokens: 120_000,
    model_reported: "test-model",
  });
  seedTurn(store, {
    thread_id: "root",
    turn_id: "t3",
    started_at: "2026-08-30T10:05:00.000Z",
    cache_read_tokens: 1_000,
    model_reported: "test-model",
  });
}

let temp: TempDatabase | undefined;
afterEach(() => {
  temp?.dispose();
  temp = undefined;
});

describe("cache-miss first-turn correlate", () => {
  it("never fires for a mid-thread turn when the range truncates the thread", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThreeTurnThread(store);

    // A 1d window starts at t2, so t2 leads the loaded slice while being the
    // thread's SECOND turn.
    const rows = detectCacheMisses(
      { db: store.db, store, catalog: testCatalog(), now: () => NOW },
      { threadId: "root", range: "1d" },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.turnId).toBe("t3");
    expect(rows[0]?.cause).not.toBe("first-turn");
    expect(rows[0]?.correlates.map((c) => c.kind)).not.toContain("first-turn");
  });

  it("still fires when the prior turn really is the thread's first", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, { thread_id: "solo" });
    seedTurn(store, {
      thread_id: "solo",
      turn_id: "a",
      started_at: "2026-08-30T10:00:00.000Z",
      cache_read_tokens: 120_000,
      model_reported: "test-model",
    });
    seedTurn(store, {
      thread_id: "solo",
      turn_id: "b",
      started_at: "2026-08-30T10:05:00.000Z",
      cache_read_tokens: 1_000,
      model_reported: "test-model",
    });

    const rows = detectCacheMisses(
      { db: store.db, store, catalog: testCatalog(), now: () => NOW },
      { threadId: "solo", range: "1d" },
    );

    expect(rows[0]?.cause).toBe("first-turn");
  });
});
