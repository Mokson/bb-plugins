// TECH invariant 2: the `obs_action` row exists BEFORE the send call.
//
// A steer that reached a thread and left no trace is the failure mode that
// would make the action table a lie. The assertion is made from inside the
// send stub: at the moment the ladder calls out to bb, the row must already be
// readable from the database. Ordering asserted against the fake host, not
// inferred from reading the source.
import { afterEach, describe, expect, it } from "vitest";
import { createLadder } from "../src/watch/ladder.js";
import {
  ladderDeps,
  makeWatchFixture,
  T0,
  type WatchFixture,
} from "./fakes.js";

let fixture: WatchFixture;
const clock = { now: T0 };

afterEach(() => fixture?.dispose());

function steerable(fixture: WatchFixture): string {
  const thread = fixture.seedThread({ threadId: "thr-steer" });
  fixture.seedTurns(thread, [
    {
      turnId: "turn-1",
      seqStarted: 1,
      startedAt: -900_000,
      completedAt: -900_000,
    },
  ]);
  fixture.seedItems(thread, [
    { seq: 2, kind: "toolCall", startedAt: -600_000, completedAt: -600_000 },
  ]);
  return thread;
}

describe("a steer", () => {
  it("has its action row on disk by the time the send is called", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({}, clock);
    const thread = steerable(fixture);

    const rowsAtSendTime: Array<{ action: string; result: string | null }> = [];
    const ladder = createLadder(
      ladderDeps(fixture, () => clock.now, {
        config: () => ({ mode: "steer", quietHours: null }),
        send: async () => {
          for (const row of fixture.runtime.queries.steerHistory(
            thread,
            new Date(clock.now - 60_000).toISOString(),
          )) {
            rowsAtSendTime.push({ action: row.action, result: row.result });
          }
          return { ok: true };
        },
      }),
    );

    ladder.applyLadder({
      signalId: fixture.store.openSignal({
        module: "watch",
        kind: "silence-no-inflight",
        dedupeKey: `${thread}:silence-no-inflight:item:2`,
        threadId: thread,
        severity: "warn",
        openedAt: new Date(clock.now).toISOString(),
      }),
      threadId: thread,
      rule: "silence-no-inflight",
      state: "open",
      severity: "warn",
      evidence: "silent 10m with nothing in flight",
      at: new Date(clock.now).toISOString(),
    });
    await ladder.settled();

    expect(rowsAtSendTime).toEqual([{ action: "steer", result: "steered" }]);
  });

  it("keeps the decision row and adds a failure row when the send throws", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({}, clock);
    const thread = steerable(fixture);

    const ladder = createLadder(
      ladderDeps(fixture, () => clock.now, {
        config: () => ({ mode: "steer", quietHours: null }),
        send: async () => {
          throw new Error("provider refused");
        },
      }),
    );

    const verdict = await ladder.steer(thread, { actor: "test" });
    // The verdict is what the ladder DECIDED, since the row was written
    // before the send could fail. The failure is a second row, not a rewrite.
    expect(verdict).toBe("steered");

    const rows = fixture.runtime.queries.actionsForThread(thread, 10);
    const results = rows.map((row) => row.action);
    expect(results.filter((action) => action === "steer")).toHaveLength(2);
    expect(
      rows.some((row) => (row.detail ?? "").includes("send failed")),
    ).toBe(true);
  });
});
