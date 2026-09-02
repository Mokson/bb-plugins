// QA F1: a signal outlives the thread it was about.
//
// `evaluateThread` reconciles a LIVE thread — a rule that stopped holding
// closes its episode. But it only ever runs for threads the sweep considers
// active, so a thread that went idle, archived or failed while a signal was
// open left that signal open forever. In the live database that was every open
// row: 235 of 235, on idle or errored threads, which is what made the open
// count useless as a precision signal.
import { afterEach, describe, expect, it } from "vitest";
import { makeWatchFixture, T0, type WatchFixture } from "./fakes.js";

let fixture: WatchFixture;
const clock = { now: T0 };

afterEach(() => fixture?.dispose());

/** An active thread with one open silence signal. */
function seedStalled(fixture: WatchFixture, threadId: string): string {
  fixture.seedThread({ threadId });
  fixture.seedTurns(threadId, [
    {
      turnId: "turn-1",
      seqStarted: 1,
      startedAt: -900_000,
      completedAt: -900_000,
    },
  ]);
  fixture.seedItems(threadId, [
    { seq: 2, kind: "toolCall", startedAt: -600_000, completedAt: -600_000 },
  ]);
  expect(fixture.runtime.engine.evaluateThread(threadId)!.opened).toBe(1);
  return threadId;
}

describe("an open watch signal", () => {
  it("closes when its thread goes idle", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({ "watch_activeNoTurn_enabled": false }, clock);
    await fixture.runtime.refresh();
    const thread = seedStalled(fixture, "thr-going-idle");

    fixture.store.upsertThread({ thread_id: thread, status: "idle" });
    const closed = fixture.runtime.engine.closeStale();

    expect(closed).toHaveLength(1);
    expect(closed[0]?.state).toBe("closed");
    expect(
      fixture.runtime.queries.openSignals(thread),
    ).toHaveLength(0);
  });

  it("closes when its thread fails or is archived", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({ "watch_activeNoTurn_enabled": false }, clock);
    await fixture.runtime.refresh();
    const failed = seedStalled(fixture, "thr-failed");
    const archived = seedStalled(fixture, "thr-archived");

    fixture.store.upsertThread({ thread_id: failed, status: "error" });
    fixture.store.upsertThread({ thread_id: archived, status: "archived" });
    fixture.runtime.engine.closeStale();

    expect(fixture.runtime.queries.openSignals(failed)).toHaveLength(0);
    expect(fixture.runtime.queries.openSignals(archived)).toHaveLength(0);
  });

  it("closes on the next sweep when the rule stops holding", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({ "watch_activeNoTurn_enabled": false }, clock);
    await fixture.runtime.refresh();
    const thread = seedStalled(fixture, "thr-recovering");

    // The agent wakes up. The silence anchor moves, so the episode closes.
    fixture.seedItems(thread, [
      { seq: 3, kind: "toolCall", startedAt: 0, completedAt: 500 },
    ]);
    fixture.runtime.engine.sweep();

    expect(fixture.runtime.queries.openSignals(thread)).toHaveLength(0);
  });

  it("leaves a running thread's signal alone", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({ "watch_activeNoTurn_enabled": false }, clock);
    await fixture.runtime.refresh();
    const thread = seedStalled(fixture, "thr-still-stuck");

    expect(fixture.runtime.engine.closeStale()).toEqual([]);
    expect(fixture.runtime.queries.openSignals(thread)).toHaveLength(1);
  });

  it("is idempotent: a second pass closes nothing and records nothing new", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({ "watch_activeNoTurn_enabled": false }, clock);
    await fixture.runtime.refresh();
    const thread = seedStalled(fixture, "thr-twice");
    fixture.store.upsertThread({ thread_id: thread, status: "idle" });

    fixture.runtime.engine.closeStale();
    const after = fixture.runtime.queries.actionsForThread(thread, 100).length;
    expect(fixture.runtime.engine.closeStale()).toEqual([]);
    expect(fixture.runtime.queries.actionsForThread(thread, 100)).toHaveLength(
      after,
    );
  });
});
