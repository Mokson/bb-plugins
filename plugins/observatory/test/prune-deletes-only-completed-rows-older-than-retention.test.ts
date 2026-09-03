// Retention deletes only what it can age: completed turns, items and log
// rows older than their window. Running rows, undated rows, signals and
// actions survive, and a second pass deletes nothing new.
import { afterEach, describe, expect, it } from "vitest";
import { TempDatabase } from "./fakes.js";

let temp: TempDatabase | undefined;
afterEach(() => {
  temp?.dispose();
  temp = undefined;
});

describe("prune", () => {
  it("deletes only completed rows older than the retention windows", () => {
    temp = new TempDatabase();
    const store = temp.open();
    store.upsertThread({ thread_id: "thr-1" });
    // Completed long ago: pruned. Running (no completion): kept.
    store.upsertTurn({
      thread_id: "thr-1",
      turn_id: "old",
      completed_at: "2020-01-01T00:00:00.000Z",
    });
    store.upsertTurn({
      thread_id: "thr-1",
      turn_id: "running",
      started_at: "2020-01-01T00:00:00.000Z",
    });
    store.upsertTurn({
      thread_id: "thr-1",
      turn_id: "fresh",
      completed_at: new Date().toISOString(),
    });
    store.upsertItem({
      item_id: "old-item",
      thread_id: "thr-1",
      completed_at: "2020-01-01T00:00:00.000Z",
    });
    store.upsertItem({
      item_id: "fresh-item",
      thread_id: "thr-1",
      completed_at: new Date().toISOString(),
    });
    store.db
      .prepare(
        `INSERT INTO obs_log_turn (log_key, ts) VALUES ('old-log', 0), ('new-log', ?)`,
      )
      .run(Date.now());

    const first = store.prune({
      itemsDays: 30,
      logTurnsDays: 90,
      turnsDays: 365,
    });

    expect(first).toMatchObject({
      items: 1,
      logTurns: 1,
      turns: 1,
    });
    expect(store.counts()).toMatchObject({ turns: 2, items: 1 });

    const second = store.prune({
      itemsDays: 30,
      logTurnsDays: 90,
      turnsDays: 365,
    });
    expect(second).toMatchObject({
      items: 0,
      logTurns: 0,
      turns: 0,
      matches: 0,
      meta: 0,
    });
  });
});
