// Opening the same signal twice is the NORMAL case: every scan re-derives its
// episodes. The dedupe key is what makes that idempotent, so the second open
// must return the first episode's id rather than a second row.
import { afterEach, describe, expect, it } from "vitest";
import { TempDatabase } from "./fakes.js";

let temp: TempDatabase | undefined;
afterEach(() => {
  temp?.dispose();
  temp = undefined;
});

describe("openSignal", () => {
  it("returns the existing id and writes no second row", () => {
    temp = new TempDatabase();
    const store = temp.open();
    const signal = {
      module: "watch",
      kind: "stalled",
      dedupeKey: "watch:stalled:thread-1:episode-1",
      threadId: "thread-1",
      openedAt: "2026-09-01T10:00:00.000Z",
      payload: { rule: "silence-no-inflight" },
    };

    const first = store.openSignal(signal);
    const second = store.openSignal({
      ...signal,
      openedAt: "2026-09-01T10:05:00.000Z",
      payload: { rule: "read-edit-read" },
    });

    expect(second).toBe(first);
    expect(store.counts().openSignals).toBe(1);
    // The first open owns the episode: a re-open never rewrites its evidence.
    const row = store.db
      .prepare<[number], { opened_at: string; payload: string }>(
        "SELECT opened_at, payload FROM obs_signal WHERE id = ?",
      )
      .get(first)!;
    expect(row.opened_at).toBe("2026-09-01T10:00:00.000Z");
    expect(JSON.parse(row.payload)).toEqual({ rule: "silence-no-inflight" });
  });

  it("closes once, so a repeated close is harmless", () => {
    temp = new TempDatabase();
    const store = temp.open();
    const id = store.openSignal({
      module: "spend",
      kind: "cache-miss",
      dedupeKey: "spend:cache-miss:1",
      openedAt: "2026-09-01T10:00:00.000Z",
    });

    store.closeSignal(id, "2026-09-01T11:00:00.000Z");
    store.closeSignal(id, "2026-09-01T12:00:00.000Z");

    const row = store.db
      .prepare<[number], { closed_at: string }>(
        "SELECT closed_at FROM obs_signal WHERE id = ?",
      )
      .get(id)!;
    expect(row.closed_at).toBe("2026-09-01T11:00:00.000Z");
    expect(store.counts().openSignals).toBe(0);
  });
});
