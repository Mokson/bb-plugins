// Re-arming is the other half of "one episode, one row". A thread that goes
// quiet, wakes up, and goes quiet again has stalled TWICE, and both belong in
// the record. The mechanism is the episode anchor: silence anchors on the last
// item, so a new item both closes the old episode and starts the clock over.
import { afterEach, describe, expect, it } from "vitest";
import { makeWatchFixture, T0, type WatchFixture } from "./fakes.js";

let fixture: WatchFixture;
const clock = { now: T0 };

afterEach(() => fixture?.dispose());

describe("the silence rule", () => {
  it("closes on a new item and opens a second episode when silence returns", async () => {
    clock.now = T0;
    fixture = makeWatchFixture(
      { "watch_activeNoTurn_enabled": false },
      clock,
    );
    await fixture.runtime.refresh();
    const thread = fixture.seedThread({ threadId: "thr-silent" });
    fixture.seedTurns(thread, [
      {
        turnId: "turn-1",
        seqStarted: 1,
        startedAt: -600_000,
        completedAt: -600_000,
      },
    ]);
    fixture.seedItems(thread, [
      { seq: 2, kind: "toolCall", startedAt: -300_000, completedAt: -300_000 },
    ]);

    const opened = fixture.runtime.engine.evaluateThread(thread)!;
    expect(opened.opened).toBe(1);

    // The agent wakes up: a new item lands right now.
    fixture.seedItems(thread, [
      { seq: 3, kind: "toolCall", startedAt: 0, completedAt: 500 },
    ]);
    clock.now = T0 + 1_000;
    const cleared = fixture.runtime.engine.evaluateThread(thread)!;
    expect(cleared.closed).toBe(1);
    expect(cleared.opened).toBe(0);

    // ...and goes quiet again, five minutes past the new item.
    clock.now = T0 + 300_000;
    const again = fixture.runtime.engine.evaluateThread(thread)!;
    expect(again.opened).toBe(1);

    const silence = fixture.runtime.queries
      .signalsForThread(thread)
      .filter((row) => row.kind === "silence-no-inflight");
    expect(silence).toHaveLength(2);
    // Exactly one is still open: the second episode.
    expect(silence.filter((row) => row.closed_at === null)).toHaveLength(1);
  });

  it("clears burn-no-change when a file change lands", async () => {
    clock.now = T0;
    fixture = makeWatchFixture(
      { "watch_activeNoTurn_enabled": false },
      clock,
    );
    await fixture.runtime.refresh();
    const thread = fixture.seedThread({ threadId: "thr-burn" });
    fixture.seedTurns(thread, [
      {
        turnId: "turn-1",
        seqStarted: 1,
        startedAt: -60_000,
        inputTokens: 100_000,
        outputTokens: 60_000,
      },
    ]);
    fixture.seedItems(thread, [
      // The rule states a fact about spending SINCE a change, so it needs a
      // change to have happened. A thread that has never edited anything is a
      // research seat, not a stalled one; see
      // docs/specs/OBS-1_observatory/evidence/watch-steer/PRECISION.md.
      {
        seq: 1,
        kind: "fileChange",
        path: "src/a.ts",
        startedAt: -50_000,
        completedAt: -49_000,
      },
      { seq: 2, kind: "toolCall", startedAt: -30_000, completedAt: -29_000 },
    ]);
    expect(fixture.runtime.engine.evaluateThread(thread)!.opened).toBe(1);

    // The file change resets the anchor AND the token count behind it.
    fixture.seedItems(thread, [
      {
        seq: 3,
        kind: "fileChange",
        path: "src/a.ts",
        startedAt: 0,
        completedAt: 100,
        turnId: "turn-2",
      },
    ]);
    fixture.seedTurns(thread, [
      { turnId: "turn-2", seqStarted: 3, startedAt: 0, inputTokens: 10 },
    ]);
    clock.now = T0 + 1_000;

    const cleared = fixture.runtime.engine.evaluateThread(thread)!;
    expect(cleared.closed).toBe(1);
    const open = fixture.runtime.queries
      .openSignals(thread)
      .filter((row) => row.kind === "burn-no-change");
    expect(open).toHaveLength(0);
  });
});
