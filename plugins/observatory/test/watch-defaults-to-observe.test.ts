// TECH invariant 6, and the two modes either side of it.
//
// `off` records nothing and sends nothing. `observe` records everything and
// sends nothing — that is the promise the whole phase-2 corpus was gathered
// under, and phase 3 adding sends must not quietly retire it. `observe` is
// also what an unconfigured install gets.
import { afterEach, describe, expect, it } from "vitest";
import { readWatchConfig } from "../src/watch/settings.js";
import { makeWatchFixture, T0, type WatchFixture } from "./fakes.js";

let fixture: WatchFixture;
const clock = { now: T0 };

afterEach(() => fixture?.dispose());

/** A thread that a steer-eligible rule fires on. */
function stalledThread(fixture: WatchFixture): string {
  const thread = fixture.seedThread({ threadId: "thr-silent" });
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

/** Fails the test on contact, and reports whether it was reached. */
function forbidSend(fixture: WatchFixture): { touched: boolean } {
  const state = { touched: false };
  Object.defineProperty(fixture.host.bb, "sdk", {
    configurable: true,
    get: () => ({
      threads: {
        send: () => {
          state.touched = true;
          throw new Error("this mode must not send");
        },
      },
    }),
  });
  return state;
}

describe("watch mode", () => {
  it("defaults to observe when nothing is configured", async () => {
    fixture = makeWatchFixture({}, clock);
    const config = await readWatchConfig(fixture.host.bb, {});
    expect(config.mode).toBe("observe");
    expect(config.premiseReminder).toBe(false);
  });

  it("records everything and sends nothing in observe", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({ "watch_mode": "observe" }, clock);
    await fixture.runtime.refresh();
    const sends = forbidSend(fixture);
    const thread = stalledThread(fixture);

    expect(
      fixture.runtime.engine.evaluateThread(thread)!.opened,
    ).toBeGreaterThan(0);
    await fixture.runtime.ladder.settled();

    expect(sends.touched).toBe(false);
    expect(
      fixture.runtime.queries.signalsForThread(thread).length,
    ).toBeGreaterThan(0);
    const actions = fixture.runtime.queries.actionsForThread(thread, 100);
    expect(actions.length).toBeGreaterThan(0);
    // Only observe rows: a refusal row on every signal would double the action
    // table forever to answer "watch is in its default mode".
    expect(actions.every((action) => action.action === "observe")).toBe(true);
  });

  it("records nothing and sends nothing in off", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({ "watch_mode": "off" }, clock);
    await fixture.runtime.refresh();
    const sends = forbidSend(fixture);
    const thread = stalledThread(fixture);

    expect(fixture.runtime.engine.evaluateThread(thread)).toBeNull();
    expect(fixture.runtime.engine.closeStale()).toEqual([]);
    await fixture.runtime.ladder.settled();

    expect(sends.touched).toBe(false);
    expect(fixture.runtime.queries.signalsForThread(thread)).toEqual([]);
    expect(fixture.runtime.queries.actionsForThread(thread, 100)).toEqual([]);
  });

  it("refuses a manual steer while the mode is not steer", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({ "watch_mode": "observe" }, clock);
    await fixture.runtime.refresh();
    const sends = forbidSend(fixture);
    const thread = stalledThread(fixture);

    expect(await fixture.runtime.ladder.steer(thread)).toBe("observe-only");
    expect(sends.touched).toBe(false);
  });
});
