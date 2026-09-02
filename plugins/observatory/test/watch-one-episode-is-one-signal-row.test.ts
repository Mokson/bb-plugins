// A stall that lasts twenty minutes is ONE thing that happened, and the
// minute sweep will look at it twenty times. If each look opened a row the
// inbox would be a stream of duplicates and "how many stalls today" would
// count ticks instead of stalls. The dedupe key carries the episode anchor,
// so re-evaluating a still-true condition finds the row it already opened.
import { afterEach, describe, expect, it } from "vitest";
import { makeWatchFixture, T0, type WatchFixture } from "./fakes.js";

let fixture: WatchFixture;
const clock = { now: T0 };

afterEach(() => fixture?.dispose());

describe("one stall episode", () => {
  it("stays one signal row across repeated evaluations", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({}, clock);
    await fixture.runtime.refresh();
    const thread = fixture.seedThread({ threadId: "thr-loop" });
    fixture.seedTurns(thread, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -60_000 },
    ]);
    fixture.seedItems(
      thread,
      [2, 3, 4].map((seq) => ({
        seq,
        kind: "toolCall",
        name: "Bash",
        fingerprint: "fp-ls",
        startedAt: -50_000 + seq * 1_000,
        completedAt: -49_000 + seq * 1_000,
      })),
    );

    const first = fixture.runtime.engine.evaluateThread(thread)!;
    expect(first.opened).toBe(1);

    // Five more sweeps over an unchanged loop. The thread also drifts into
    // silence along the way, which is a real second finding and not this
    // test's business, so only the loop rule's transitions are counted.
    for (let tick = 1; tick <= 5; tick += 1) {
      clock.now = T0 + tick * 60_000;
      const result = fixture.runtime.engine.evaluateThread(thread)!;
      const loopTransitions = result.transitions.filter(
        (transition) => transition.rule === "repeated-identical-tool",
      );
      expect(loopTransitions).toEqual([]);
    }

    const rows = fixture.runtime.queries.signalsForThread(thread);
    const loops = rows.filter(
      (row) => row.kind === "repeated-identical-tool",
    );
    expect(loops).toHaveLength(1);
    expect(loops[0]!.closed_at).toBeNull();
  });

  it("writes an obs_action row only on the open and the close, never per tick", async () => {
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

    fixture.runtime.engine.evaluateThread(thread);
    for (let tick = 1; tick <= 4; tick += 1) {
      clock.now = T0 + tick * 60_000;
      fixture.runtime.engine.evaluateThread(thread);
    }

    // One open. Five evaluations.
    const actions = fixture.runtime.queries.actionsForThread(thread);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action).toBe("observe");
    expect(actions[0]!.detail).toContain("silence-no-inflight open");
  });
});
