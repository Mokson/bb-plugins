// Quiet hours and the notification caps govern the NOTIFICATION, never the
// record. Losing the signal row too would make a quiet night look like a quiet
// system, and the morning inbox is the whole point of recording overnight.
import { afterEach, describe, expect, it } from "vitest";
import { SIGNAL_CHANNEL } from "../src/watch/contract.js";
import {
  OVERALL_HOURLY_CAP,
  PER_THREAD_HOURLY_CAP,
} from "../src/watch/ladder.js";
import { inQuietHours, parseQuietHours } from "../src/watch/settings.js";
import { makeWatchFixture, T0, type WatchFixture } from "./fakes.js";

let fixture: WatchFixture;

afterEach(() => fixture?.dispose());

/** Tests run with TZ=UTC (vitest.config.ts), so local hour is the UTC hour. */
const MIDNIGHT = Date.parse("2026-09-02T00:30:00.000Z");

function seedLoop(f: WatchFixture, threadId: string, fingerprint: string): string {
  const thread = f.seedThread({ threadId });
  f.seedTurns(thread, [
    { turnId: `${threadId}-turn`, seqStarted: 1, startedAt: -60_000 },
  ]);
  f.seedItems(
    thread,
    [2, 3, 4].map((seq) => ({
      seq,
      kind: "toolCall",
      name: "Bash",
      fingerprint,
      startedAt: -50_000 + seq * 1_000,
      completedAt: -49_000 + seq * 1_000,
      turnId: `${threadId}-turn`,
    })),
  );
  return thread;
}

describe("the quiet hours window", () => {
  it("wraps midnight", () => {
    const hours = parseQuietHours("22-07");
    expect(hours).toEqual({ from: 22, to: 7 });
    expect(inQuietHours(hours, new Date("2026-09-01T23:00:00Z"))).toBe(true);
    expect(inQuietHours(hours, new Date("2026-09-02T03:00:00Z"))).toBe(true);
    expect(inQuietHours(hours, new Date("2026-09-02T12:00:00Z"))).toBe(false);
    // A typo disables the window rather than silencing everything forever.
    expect(parseQuietHours("nonsense")).toBeNull();
  });

  it("suppresses the publish but still writes the signal and the action", async () => {
    const clock = { now: MIDNIGHT };
    fixture = makeWatchFixture({ "watch_quietHours": "22-07" }, clock);
    await fixture.runtime.refresh();
    const thread = seedLoop(fixture, "thr-night", "fp-ls");

    const result = fixture.runtime.engine.evaluateThread(thread)!;
    expect(result.opened).toBeGreaterThan(0);

    // Nothing reached the UI...
    expect(fixture.published()).toHaveLength(0);
    // ...but the evidence is on disk.
    const open = fixture.runtime.queries
      .openSignals(thread)
      .filter((row) => row.kind === "repeated-identical-tool");
    expect(open).toHaveLength(1);
    expect(fixture.runtime.queries.actionsForThread(thread).length).toBe(
      result.transitions.length,
    );
  });

  it("publishes outside the window", async () => {
    const clock = { now: T0 };
    fixture = makeWatchFixture({ "watch_quietHours": "22-07" }, clock);
    await fixture.runtime.refresh();
    const thread = seedLoop(fixture, "thr-day", "fp-ls");

    fixture.runtime.engine.evaluateThread(thread);

    const published = fixture.published();
    expect(published.length).toBeGreaterThan(0);
    expect(published[0]!.channel).toBe(SIGNAL_CHANNEL);
    expect(published[0]!.payload).toMatchObject({
      threadId: thread,
      state: "open",
    });
  });
});

describe("the notification caps", () => {
  it("stops at six publishes for one thread inside an hour", async () => {
    const clock = { now: T0 };
    fixture = makeWatchFixture({ "watch_quietHours": "" }, clock);
    await fixture.runtime.refresh();

    // Drive transitions directly: the cap is the ladder's contract, and
    // manufacturing eight distinct rule episodes would test the rules instead.
    const ladderThread = "thr-capped";
    fixture.seedThread({ threadId: ladderThread });
    for (let n = 0; n < PER_THREAD_HOURLY_CAP + 3; n += 1) {
      const signalId = fixture.store.openSignal({
        module: "watch",
        kind: "silence-no-inflight",
        dedupeKey: `${ladderThread}:silence-no-inflight:item:${n}`,
        threadId: ladderThread,
        severity: "warn",
        openedAt: new Date(T0).toISOString(),
      });
      fixture.runtime.ladder.applyLadder({
        signalId,
        threadId: ladderThread,
        rule: "silence-no-inflight",
        state: "open",
        severity: "warn",
        evidence: `episode ${n}`,
        at: new Date(T0).toISOString(),
      });
    }

    expect(fixture.published()).toHaveLength(PER_THREAD_HOURLY_CAP);
    // Every transition is still recorded, capped or not.
    expect(
      fixture.runtime.queries.actionsForThread(ladderThread, 100),
    ).toHaveLength(PER_THREAD_HOURLY_CAP + 3);
  });

  it("stops at twenty publishes overall inside an hour", async () => {
    const clock = { now: T0 };
    fixture = makeWatchFixture({ "watch_quietHours": "" }, clock);
    await fixture.runtime.refresh();

    let attempts = 0;
    // Spread across enough threads that the per-thread cap never binds first.
    for (let thread = 0; thread < 10; thread += 1) {
      const threadId = `thr-${thread}`;
      fixture.seedThread({ threadId });
      for (let n = 0; n < 5; n += 1) {
        attempts += 1;
        const signalId = fixture.store.openSignal({
          module: "watch",
          kind: "silence-no-inflight",
          dedupeKey: `${threadId}:silence-no-inflight:item:${n}`,
          threadId,
          severity: "warn",
          openedAt: new Date(T0).toISOString(),
        });
        fixture.runtime.ladder.applyLadder({
          signalId,
          threadId,
          rule: "silence-no-inflight",
          state: "open",
          severity: "warn",
          evidence: `episode ${n}`,
          at: new Date(T0).toISOString(),
        });
      }
    }

    expect(attempts).toBeGreaterThan(OVERALL_HOURLY_CAP);
    expect(fixture.published()).toHaveLength(OVERALL_HOURLY_CAP);
  });
});
