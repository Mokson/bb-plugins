// PRODUCT invariant 23: tree budget cannot veto a spawn. On breach it steers
// the PARENT with the subtree bill.
//
// So a subtree breach is not an ordinary rung-1 steer at the child; it goes
// straight to rung 3, because the child cannot decide to stop being expensive
// and the parent can. The day breach is a different fact with a different
// owner and stays where it is.
import { afterEach, describe, expect, it } from "vitest";
import { ESCALATION_CHANNEL } from "../src/watch/contract.js";
import { createLadder, type Ladder } from "../src/watch/index.js";
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
}

function steerLadder(fixture: WatchFixture, sent: Sent[]): Ladder {
  return createLadder(
    ladderDeps(fixture, () => clock.now, {
      config: () => ({ mode: "steer", quietHours: null }),
      send: async (args) => {
        sent.push(args as Sent);
        return { ok: true };
      },
    }),
  );
}

describe("a tree budget breach", () => {
  it("steers the parent with the subtree bill on the first crossing", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({}, clock);
    fixture.seedThread({ threadId: "thr-parent", status: "active" });
    const child = fixture.seedThread({
      threadId: "thr-child",
      status: "active",
      rootThreadId: "thr-parent",
    });
    fixture.store.upsertThread({
      thread_id: child,
      parent_thread_id: "thr-parent",
      root_thread_id: "thr-parent",
    });
    const sent: Sent[] = [];
    const ladder = steerLadder(fixture, sent);

    const signalId = fixture.store.openSignal({
      module: "watch",
      kind: "tree-budget",
      dedupeKey: `${child}:tree-budget:tree:thr-parent:0`,
      threadId: child,
      severity: "critical",
      openedAt: new Date(clock.now).toISOString(),
    });
    ladder.applyLadder({
      signalId,
      threadId: child,
      rule: "tree-budget",
      state: "open",
      severity: "critical",
      evidence: "subtree spend $103.40 over the $50 ceiling",
      at: new Date(clock.now).toISOString(),
    });
    await ladder.settled();

    expect(sent).toHaveLength(1);
    // The parent, not the child, and the bill travels with it.
    expect(sent[0]?.threadId).toBe("thr-parent");
    expect(sent[0]?.text).toContain("$103.40");
    expect(
      fixture.published().map((signal) => signal.channel as string),
    ).toContain(ESCALATION_CHANNEL);
  });

  it("re-arms on the doubling band and not before", async () => {
    // The rule's own anchor, exercised end to end: subtree spend only grows,
    // so anchoring on the root alone would fire once and never again. The
    // log2 band re-anchors at every 2x of the ceiling.
    clock.now = T0;
    fixture = makeWatchFixture({ "watch_treeBudget_enabled": true }, clock);
    await fixture.runtime.refresh();
    const root = fixture.seedThread({ threadId: "thr-root", status: "active" });
    fixture.seedTurns(root, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -1_000, costUsd: 80 },
    ]);

    fixture.runtime.engine.evaluateThread(root);
    const first = fixture.runtime.queries
      .signalsForThread(root, 50)
      .filter((row) => row.kind === "tree-budget");
    expect(first).toHaveLength(1);

    // Still inside the first band: no second episode.
    fixture.seedTurns(root, [
      { turnId: "turn-2", seqStarted: 2, startedAt: -900, costUsd: 15 },
    ]);
    fixture.runtime.engine.evaluateThread(root);
    expect(
      fixture.runtime.queries
        .signalsForThread(root, 50)
        .filter((row) => row.kind === "tree-budget"),
    ).toHaveLength(1);

    // Past 2x the ceiling: a new band, a new episode.
    fixture.seedTurns(root, [
      { turnId: "turn-3", seqStarted: 3, startedAt: -800, costUsd: 40 },
    ]);
    fixture.runtime.engine.evaluateThread(root);
    expect(
      fixture.runtime.queries
        .signalsForThread(root, 50)
        .filter((row) => row.kind === "tree-budget"),
    ).toHaveLength(2);
  });
});
