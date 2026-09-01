// The detector runs on EVERY thread drain, so re-deriving the same episode is
// the normal case rather than the exception. Idempotence comes from the signal
// dedupe key, not from remembering what was already scanned — which is what
// lets a backfill and a live drain race without doubling the inbox.
import { afterEach, describe, expect, it } from "vitest";
import {
  cacheMissDedupeKey,
  detectCacheMisses,
} from "../src/spend/cache-miss.js";
import { scanFingerprints } from "../src/spend/fingerprint.js";
import { TempDatabase } from "./fakes.js";
import { seedLogTurn, seedThread, seedTurn, testCatalog } from "./spend-fixtures.js";

const NOW = Date.parse("2026-08-31T00:00:00.000Z");

let temp: TempDatabase | undefined;
afterEach(() => {
  temp?.dispose();
  temp = undefined;
});

describe("spend detectors", () => {
  it("opens one cache-miss signal however often it is re-run", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, { thread_id: "root" });
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t1",
      started_at: "2026-08-30T10:00:00.000Z",
      completed_at: "2026-08-30T10:00:30.000Z",
      cache_read_tokens: 120_000,
      model_reported: "test-model",
    });
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t2",
      started_at: "2026-08-30T10:01:00.000Z",
      cache_read_tokens: 1_000,
      model_reported: "other-model",
    });
    const deps = {
      db: store.db,
      store,
      catalog: testCatalog(),
      now: () => NOW,
    };

    const first = detectCacheMisses(deps, { threadId: "root" });
    const second = detectCacheMisses(deps, { threadId: "root" });
    const third = detectCacheMisses(deps, { range: "7d" as const });

    expect(first).toHaveLength(1);
    // The scan still REPORTS the miss every time; what is idempotent is the
    // episode it opens, so a drilldown never needs the signal table.
    expect(second).toHaveLength(1);
    expect(third).toHaveLength(1);
    const count = store.db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM obs_signal WHERE dedupe_key = ?",
      )
      .get(cacheMissDedupeKey("root", "t2"));
    expect(count?.n).toBe(1);
    expect(store.counts().openSignals).toBe(1);
  });

  it("opens one prefix-changed signal per transition, however often it is re-run", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, { thread_id: "root" });
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t1",
      started_at: "2026-08-30T10:00:00.000Z",
      model_reported: "test-model",
    });
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t2",
      started_at: "2026-08-30T10:01:00.000Z",
      model_reported: "test-model",
    });
    seedLogTurn(store, {
      threadId: "root",
      turnId: "t1",
      logKey: "log-1",
      skillNames: ["implement"],
    });
    seedLogTurn(store, {
      threadId: "root",
      turnId: "t2",
      logKey: "log-2",
      skillNames: ["implement", "refine"],
    });
    const deps = { db: store.db, store };

    const first = scanFingerprints(deps, { threadId: "root" });
    scanFingerprints(deps, { threadId: "root" });

    expect(first).toHaveLength(1);
    expect(first[0]?.turnId).toBe("t2");
    expect(
      store.db
        .prepare<[], { n: number }>(
          "SELECT COUNT(*) AS n FROM obs_signal WHERE kind = 'prefix-changed'",
        )
        .get()?.n,
    ).toBe(1);
  });
});
