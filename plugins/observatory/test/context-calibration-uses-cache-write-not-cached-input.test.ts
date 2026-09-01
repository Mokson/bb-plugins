import { afterEach, beforeEach, expect, test } from "vitest";
import { calibrate, firstTurnCacheWrites } from "../src/context/estimate.js";
import { TempDatabase } from "./fakes.js";

let temp!: TempDatabase;
beforeEach(() => {
  temp = new TempDatabase();
});
afterEach(() => temp.dispose());

function logTurn(
  db: ReturnType<TempDatabase["openDatabase"]>,
  row: {
    key: string;
    session: string;
    ts: number;
    cacheWrite: number | null;
    cacheRead: number;
  },
): void {
  db.prepare(
    `INSERT INTO obs_log_turn
       (log_key, provider, provider_thread_id, ts, cache_read, cache_write)
     VALUES (?, 'claude-code', ?, ?, ?, ?)`,
  ).run(row.key, row.session, row.ts, row.cacheRead, row.cacheWrite);
}

test("calibration reads the first turn's cache_write, not a later cached read", () => {
  const store = temp.open();
  const db = store.db;
  // The prefix was written once at 1000 tokens. Every later turn RE-READS a
  // window that has grown with the conversation: calibrating on those would
  // report a prefix ninety times too large.
  logTurn(db, { key: "a1", session: "s1", ts: 1_000, cacheWrite: 1000, cacheRead: 0 });
  logTurn(db, { key: "a2", session: "s1", ts: 2_000, cacheWrite: 20, cacheRead: 90_000 });
  logTurn(db, { key: "b1", session: "s2", ts: 3_000, cacheWrite: 1000, cacheRead: 0 });

  expect(firstTurnCacheWrites(db, "claude-code", 0)).toEqual([1000, 1000]);

  const result = calibrate({
    db,
    provider: "claude-code",
    rawEstimate: 500,
    sinceMs: 0,
    getMeta: (key) => store.getMeta(key),
    setMeta: (key, value) => store.setMeta(key, value),
  });

  expect(result.factor).toBe(2);
  expect(result.samples).toBe(2);
});

test("the reported error judges the stored factor before it is refitted", () => {
  const store = temp.open();
  const db = store.db;
  logTurn(db, { key: "a1", session: "s1", ts: 1_000, cacheWrite: 1000, cacheRead: 0 });
  const args = {
    db,
    provider: "claude-code",
    rawEstimate: 500,
    sinceMs: 0,
    getMeta: (key: string) => store.getMeta(key),
    setMeta: (key: string, value: string) => store.setMeta(key, value),
  };

  // First pass has no stored factor: the raw estimate is 500 against 1000.
  expect(calibrate(args).error).toBeCloseTo(0.5, 6);
  // Second pass predicts with the factor just learned and is exact.
  expect(calibrate(args).error).toBeCloseTo(0, 6);
});
