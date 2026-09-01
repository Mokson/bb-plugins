// An episode anchor can RECUR. A thread that goes quiet after item 42, wakes
// up because a turn landed, and goes quiet after that same item 42 has stalled
// twice, and the second stall must open its own row.
//
// The failure this pins down is a global UNIQUE index on `dedupe_key`: the
// reopen collided with the CLOSED first episode, `openSignal` handed back the
// closed row's id, the reconcile never saw it among the open rows, and so
// every sweep from then on recorded another action and broadcast "open" again
// for a signal that already existed. The index is scoped to open rows instead.
import { afterEach, describe, expect, it } from "vitest";
import { makeWatchFixture, T0, type WatchFixture } from "./fakes.js";
import { SIGNAL_CHANNEL } from "../src/watch/contract.js";

let fixture: WatchFixture;
const clock = { now: T0 };

afterEach(() => fixture?.dispose());

describe("a closed episode whose anchor recurs", () => {
  it("opens a second row and never re-broadcasts the first", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({ "watch_activeNoTurn_enabled": false }, clock);
    await fixture.runtime.refresh();
    const thread = fixture.seedThread({ threadId: "thr-recur" });
    fixture.seedTurns(thread, [
      {
        turnId: "turn-1",
        seqStarted: 1,
        startedAt: -600_000,
        completedAt: -600_000,
      },
    ]);
    // The anchor. It never moves for the rest of this test.
    fixture.seedItems(thread, [
      { seq: 42, kind: "toolCall", startedAt: -600_000, completedAt: -600_000 },
    ]);

    expect(fixture.runtime.engine.evaluateThread(thread)!.opened).toBe(1);

    // A turn lands. `lastEventAt` is now, so the silence clears — but no new
    // item arrived, so the episode anchor is still `item:42`.
    fixture.seedTurns(thread, [
      { turnId: "turn-2", seqStarted: 43, startedAt: 0, completedAt: 0 },
    ]);
    clock.now = T0 + 1_000;
    expect(fixture.runtime.engine.evaluateThread(thread)!.closed).toBe(1);

    // Quiet again, past the threshold, against the very same anchor.
    clock.now = T0 + 600_000;
    expect(fixture.runtime.engine.evaluateThread(thread)!.opened).toBe(1);

    const silence = fixture.runtime.queries
      .signalsForThread(thread)
      .filter((row) => row.kind === "silence-no-inflight");
    expect(silence).toHaveLength(2);
    expect(silence.filter((row) => row.closed_at === null)).toHaveLength(1);

    // Later sweeps see the second episode already open and say nothing.
    for (let tick = 1; tick <= 3; tick += 1) {
      clock.now = T0 + 600_000 + tick * 60_000;
      expect(fixture.runtime.engine.evaluateThread(thread)!.transitions).toEqual(
        [],
      );
    }

    const opens = fixture
      .published()
      .filter(
        (signal) =>
          signal.channel === SIGNAL_CHANNEL &&
          (signal.payload as { kind?: string; state?: string }).kind ===
            "silence-no-inflight" &&
          (signal.payload as { state?: string }).state === "open",
      );
    expect(opens).toHaveLength(2);
  });
});
