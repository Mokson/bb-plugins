// The rungs, and the guards that bound them.
//
// Rung 1 is one steer. Rung 2 is a second, and ONLY when a different rule
// fires. Rung 3 escalates to the parent, publishes on `observatory/escalation`
// and re-broadcasts the row status. Everything else the ladder is asked to do
// inside the cooldown is a recorded refusal.
import { afterEach, describe, expect, it } from "vitest";
import {
  ESCALATION_CHANNEL,
  SIGNAL_CHANNEL,
} from "../src/watch/contract.js";
import {
  createLadder,
  OVERALL_HOURLY_CAP,
  PER_THREAD_HOURLY_CAP,
  type Ladder,
  type RuleId,
} from "../src/watch/index.js";
import {
  ladderDeps,
  makeWatchFixture,
  T0,
  type WatchFixture,
} from "./fakes.js";

let fixture: WatchFixture;
const clock = { now: T0 };

afterEach(() => fixture?.dispose());

interface Sent {
  threadId: string;
  text: string;
  mode: string;
}

function steerLadder(
  fixture: WatchFixture,
  sent: Sent[],
  quietHours: { from: number; to: number } | null = null,
): Ladder {
  return createLadder(
    ladderDeps(fixture, () => clock.now, {
      config: () => ({ mode: "steer", quietHours }),
      send: async (args) => {
        sent.push(args as Sent);
        return { ok: true };
      },
    }),
  );
}

/** Fire one signal of `rule` through the ladder, and wait for the send. */
async function fire(
  ladder: Ladder,
  threadId: string,
  rule: RuleId,
  evidence = "evidence line",
): Promise<void> {
  const signalId = fixture.store.openSignal({
    module: "watch",
    kind: rule,
    dedupeKey: `${threadId}:${rule}:${clock.now}:${Math.random()}`,
    threadId,
    severity: "warn",
    openedAt: new Date(clock.now).toISOString(),
  });
  ladder.applyLadder({
    signalId,
    threadId,
    rule,
    state: "open",
    severity: "warn",
    evidence,
    at: new Date(clock.now).toISOString(),
  });
  await ladder.settled();
}

function seedActive(
  fixture: WatchFixture,
  options: Parameters<WatchFixture["seedThread"]>[0] = {},
): string {
  const thread = fixture.seedThread({ threadId: "thr-loop", ...options });
  fixture.seedTurns(thread, [
    {
      turnId: "turn-1",
      seqStarted: 1,
      startedAt: -900_000,
      completedAt: -900_000,
    },
  ]);
  return thread;
}

describe("the rungs", () => {
  it("steers once, refuses the same rule again, and steers a different one", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({}, clock);
    const thread = seedActive(fixture);
    const sent: Sent[] = [];
    const ladder = steerLadder(fixture, sent);

    // Rung 1.
    await fire(ladder, thread, "silence-no-inflight", "silent 12m");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.threadId).toBe(thread);
    expect(sent[0]?.mode).toBe("steer");
    // The diagnostic names the rule and the numbers, not just "you seem stuck".
    expect(sent[0]?.text).toContain("silence-no-inflight");
    expect(sent[0]?.text).toContain("silent 12m");

    // The same rule again, inside the ten minute cooldown: refused.
    clock.now = T0 + 60_000;
    await fire(ladder, thread, "silence-no-inflight", "silent 13m");
    expect(sent).toHaveLength(1);

    // Rung 2: a DIFFERENT rule inside the same cooldown.
    await fire(ladder, thread, "retry-storm", "4 retrying provider errors");
    expect(sent).toHaveLength(2);
    expect(sent[1]?.text).toContain("retry-storm");

    // The refusal is recorded, not silent.
    const refusals = fixture.runtime.queries
      .actionsForThread(thread, 50)
      .filter((row) => (row.detail ?? "").includes("silent 13m"));
    expect(refusals.some((row) => row.action === "steer")).toBe(true);
  });

  it("escalates to the parent on a third distinct rule, and publishes", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({}, clock);
    fixture.seedThread({ threadId: "thr-parent", status: "active" });
    const child = seedActive(fixture, {
      threadId: "thr-child",
      rootThreadId: "thr-parent",
    });
    fixture.store.upsertThread({
      thread_id: child,
      parent_thread_id: "thr-parent",
      root_thread_id: "thr-parent",
    });
    const sent: Sent[] = [];
    const ladder = steerLadder(fixture, sent);

    await fire(ladder, child, "silence-no-inflight", "silent 12m");
    await fire(ladder, child, "retry-storm", "4 retrying provider errors");
    expect(sent).toHaveLength(2);

    await fire(ladder, child, "active-no-turn", "no turn for 20m");
    expect(sent).toHaveLength(3);
    // Rung 3 addresses the PARENT, and carries the child's evidence with it.
    expect(sent[2]?.threadId).toBe("thr-parent");
    expect(sent[2]?.text).toContain(child);
    expect(sent[2]?.text).toContain("no turn for 20m");

    const channels = fixture
      .published()
      .map((signal) => signal.channel as string);
    expect(channels).toContain(ESCALATION_CHANNEL);
    expect(channels).toContain(SIGNAL_CHANNEL);
  });

  it("never escalates past the root", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({}, clock);
    const root = seedActive(fixture, { threadId: "thr-root" });
    const sent: Sent[] = [];
    const ladder = steerLadder(fixture, sent);

    await fire(ladder, root, "silence-no-inflight", "silent 12m");
    await fire(ladder, root, "retry-storm", "4 errors");
    await fire(ladder, root, "active-no-turn", "no turn for 20m");

    // No parent, so the escalation addresses the root itself rather than
    // reaching for a thread that does not exist.
    expect(sent[2]?.threadId).toBe(root);
  });
});

describe("the steer guards", () => {
  it("refuses a rule whose precision has not been measured", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({}, clock);
    const thread = seedActive(fixture);
    const sent: Sent[] = [];
    const ladder = steerLadder(fixture, sent);

    await fire(ladder, thread, "burn-no-change", "400k tokens");
    await fire(ladder, thread, "repeated-identical-tool", "12 of the last 20");
    expect(sent).toEqual([]);

    const results = fixture.runtime.queries
      .actionsForThread(thread, 50)
      .filter((row) => row.action === "steer");
    expect(results).toHaveLength(2);
  });

  it("refuses an inactive thread and a hidden one", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({}, clock);
    const idle = fixture.seedThread({ threadId: "thr-idle", status: "idle" });
    const hidden = fixture.seedThread({
      threadId: "thr-hidden",
      status: "active",
    });
    fixture.store.upsertThread({
      thread_id: hidden,
      visibility: "hidden",
    });
    const evalThread = fixture.seedThread({
      threadId: "thr-eval",
      title: "[eval] case 12",
      status: "active",
    });
    const sent: Sent[] = [];
    const ladder = steerLadder(fixture, sent);

    await fire(ladder, idle, "silence-no-inflight", "silent 12m");
    await fire(ladder, hidden, "silence-no-inflight", "silent 12m");
    await fire(ladder, evalThread, "silence-no-inflight", "silent 12m");
    expect(sent).toEqual([]);

    expect(await ladder.steer(idle)).toBe("inactive-thread");
    expect(await ladder.steer(hidden)).toBe("reserved-thread");
    expect(await ladder.steer(evalThread)).toBe("reserved-thread");
    expect(await ladder.steer("thr-nobody")).toBe("unknown-thread");
    expect(sent).toEqual([]);
  });

  it("refuses every steer inside quiet hours", async () => {
    // 02:00 local, inside a 22-07 window.
    clock.now = new Date(2026, 8, 2, 2, 0, 0).getTime();
    fixture = makeWatchFixture({}, clock);
    const thread = seedActive(fixture);
    const sent: Sent[] = [];
    const ladder = steerLadder(fixture, sent, { from: 22, to: 7 });

    await fire(ladder, thread, "silence-no-inflight", "silent 12m");
    expect(sent).toEqual([]);
  });

  it("stops at the per-thread and overall hourly caps", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({}, clock);
    const thread = seedActive(fixture);
    const sent: Sent[] = [];
    const ladder = steerLadder(fixture, sent);

    // Each manual steer skips the cooldown (it names no rule), so this counts
    // the cap and nothing else.
    for (let n = 0; n < PER_THREAD_HOURLY_CAP + 3; n += 1) {
      await ladder.steer(thread, { actor: `test-${n}` });
    }
    expect(sent).toHaveLength(PER_THREAD_HOURLY_CAP);

    // A second thread keeps going until the overall cap binds.
    const other = fixture.seedThread({ threadId: "thr-other", status: "active" });
    for (let n = 0; n < OVERALL_HOURLY_CAP; n += 1) {
      await ladder.steer(other, { actor: `other-${n}` });
    }
    expect(sent.length).toBeLessThanOrEqual(OVERALL_HOURLY_CAP);
  });
});
