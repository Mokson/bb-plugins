// Retention deletes only what it can age: completed turns, items and log
// rows older than their window. Running rows, undated rows, signals and
// actions survive, and a second pass deletes nothing new.
import { afterEach, describe, expect, it } from "vitest";
import { parseDays } from "../src/server.js";
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

  it("keeps signal and action rows no matter their age", () => {
    temp = new TempDatabase();
    const store = temp.open();
    store.upsertThread({ thread_id: "thr-1" });
    const signalId = store.openSignal({
      module: "watch",
      kind: "stalled",
      dedupeKey: "watch:stalled:thr-1",
      threadId: "thr-1",
      openedAt: "2020-01-01T00:00:00.000Z",
    });
    store.recordAction({
      signalId,
      threadId: "thr-1",
      action: "steer",
      at: "2020-01-01T00:00:00.000Z",
      result: "sent",
    });

    const counts = store.prune({ itemsDays: 0, logTurnsDays: 0, turnsDays: 0 });

    // A zero-day window ages everything it can age, and still neither the
    // episode nor its action is something retention may touch.
    expect(counts).toMatchObject({ items: 0, logTurns: 0, turns: 0 });
    expect(store.counts()).toMatchObject({ openSignals: 1, actions: 1 });
  });

  it("deletes orphan matches and sweeps stale meta but keeps live keys", () => {
    temp = new TempDatabase();
    const store = temp.open();
    store.upsertThread({
      thread_id: "thr-1",
      provider_id: "claude-code",
      provider_thread_id: "pt-1",
    });
    store.upsertTurn({
      thread_id: "thr-1",
      turn_id: "old",
      completed_at: "2020-01-01T00:00:00.000Z",
    });
    store.upsertTurn({
      thread_id: "thr-1",
      turn_id: "fresh",
      completed_at: new Date().toISOString(),
    });
    store.db
      .prepare(
        `INSERT INTO obs_match (thread_id, turn_id, log_key)
         VALUES ('thr-1', 'old', 'old-log'), ('thr-1', 'fresh', 'fresh-log')`,
      )
      .run();
    store.setMeta("join:dead:dead", "{}");
    store.setMeta("carry:gone-thread", "{}");
    store.setMeta("join:claude-code:pt-1", "{}");
    store.setMeta("carry:thr-1", "{}");

    const counts = store.prune({
      itemsDays: 30,
      logTurnsDays: 90,
      turnsDays: 365,
    });

    // The pruned turn's pointer goes with it; the live turn keeps its match,
    // and only the keys naming sessions and threads that no longer exist go.
    expect(counts).toMatchObject({ turns: 1, matches: 1, meta: 2 });
    expect(
      store.db
        .prepare(`SELECT COUNT(*) AS n FROM obs_match`)
        .get(),
    ).toEqual({ n: 1 });
    expect(store.getMeta("join:claude-code:pt-1")).toBe("{}");
    expect(store.getMeta("carry:thr-1")).toBe("{}");
    expect(store.getMeta("join:dead:dead")).toBeNull();
    expect(store.getMeta("carry:gone-thread")).toBeNull();
  });

  it("retains an aged turn that never completed", () => {
    temp = new TempDatabase();
    const store = temp.open();
    store.upsertThread({ thread_id: "thr-1" });
    // Started years ago but still open: without a completion timestamp the
    // row cannot be aged, and a live row is never pruned.
    store.upsertTurn({
      thread_id: "thr-1",
      turn_id: "stuck",
      started_at: "2020-01-01T00:00:00.000Z",
    });

    const counts = store.prune({
      itemsDays: 30,
      logTurnsDays: 90,
      turnsDays: 365,
    });

    expect(counts).toMatchObject({ turns: 0 });
    expect(store.counts()).toMatchObject({ turns: 1 });
  });

  it("falls back to defaults on invalid retention and deletes nothing invalid", () => {
    expect(parseDays(undefined, 30)).toBe(30);
    expect(parseDays("not-a-number", 90)).toBe(90);
    expect(parseDays("-1", 30)).toBe(30);
    expect(parseDays("7", 30)).toBe(7);

    temp = new TempDatabase();
    const store = temp.open();
    store.upsertThread({ thread_id: "thr-1" });
    store.upsertTurn({
      thread_id: "thr-1",
      turn_id: "old",
      completed_at: "2020-01-01T00:00:00.000Z",
    });

    // Below the store, an invalid window is skipped rather than widened: a
    // NaN or negative retention keeps every row it would otherwise age.
    const counts = store.prune({
      itemsDays: Number.NaN,
      logTurnsDays: -1,
      turnsDays: Number.NaN,
    });

    expect(counts).toMatchObject({
      items: 0,
      logTurns: 0,
      turns: 0,
      matches: 0,
      meta: 0,
    });
    expect(store.counts()).toMatchObject({ turns: 1 });
  });
});
