// PRODUCT invariant 24: the post-compaction premise reminder.
//
// Off by default. When on, one compaction in a thread with a resolved run
// folder produces exactly ONE queued message carrying the ledger's done-when
// rows and its still-open decisions. Queued, not steered: it is context for
// the next turn, not an interruption of this one.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPremiseReminder, isOpenDecision } from "../src/watch/premise.js";
import { makeWatchFixture, T0, type WatchFixture } from "./fakes.js";

let fixture: WatchFixture;
let runFolder: string | null = null;
const clock = { now: T0 };

afterEach(() => {
  fixture?.dispose();
  if (runFolder) rmSync(runFolder, { recursive: true, force: true });
  runFolder = null;
});

const LEDGER = `# Run ledger

## Done-when

- [ ] the ladder records before it sends
- [ ] every rung has a test

## Decisions

- [x] steer mode is opt-in
- open: whether burn-no-change is steer-eligible
- decided: escalation targets the parent

## Notes

- nothing here should reach the reminder
`;

/** A run folder on disk with a ledger in it. */
function seedRunFolder(): string {
  const root = mkdtempSync(join(tmpdir(), "obs-premise-"));
  const folder = join(root, "docs", "specs", "OBS-1_observatory");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "LEDGER.md"), LEDGER, "utf8");
  runFolder = root;
  return folder;
}

/** A thread that has compacted, in a resolved run folder. */
function seedCompacted(fixture: WatchFixture, folder: string): string {
  const thread = fixture.seedThread({ threadId: "thr-compacted" });
  fixture.store.upsertThread({ thread_id: thread, run_folder: folder });
  fixture.seedTurns(thread, [
    {
      turnId: "turn-1",
      seqStarted: 1,
      startedAt: -60_000,
      completedAt: -50_000,
      compacted: true,
    },
  ]);
  return thread;
}

describe("the reminder text", () => {
  it("quotes done-when and the still-open decisions, and nothing else", () => {
    const text = buildPremiseReminder("/runs/OBS-1", LEDGER);
    expect(text).toContain("the ladder records before it sends");
    expect(text).toContain("whether burn-no-change is steer-eligible");
    // A ticked box and a row that says it was decided are both settled.
    expect(text).not.toContain("steer mode is opt-in");
    expect(text).not.toContain("escalation targets the parent");
    // A section it was not asked for does not leak in.
    expect(text).not.toContain("nothing here should reach the reminder");
  });

  it("says nothing when the ledger has nothing open", () => {
    expect(buildPremiseReminder("/runs/x", "# Ledger\n\n## Notes\n\n- a\n")).toBe(
      null,
    );
  });

  it("reads a ticked box and a resolution word as decided", () => {
    expect(isOpenDecision("- [ ] still arguing")).toBe(true);
    expect(isOpenDecision("- [x] settled")).toBe(false);
    expect(isOpenDecision("decided: parent gets it")).toBe(false);
    expect(isOpenDecision("open: which parent")).toBe(true);
  });
});

describe("the premise reminder", () => {
  it("is off by default", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({}, clock);
    await fixture.runtime.refresh();
    const thread = seedCompacted(fixture, seedRunFolder());

    expect(await fixture.runtime.remindPremise(thread)).toBe("disabled");
  });

  it("queues exactly one message per compaction when on", async () => {
    clock.now = T0;
    fixture = makeWatchFixture(
      { "watch_premiseReminder": true, "watch_mode": "steer" },
      clock,
    );
    await fixture.runtime.refresh();
    const thread = seedCompacted(fixture, seedRunFolder());

    const sent: Array<{ threadId: string; mode: string; text: string }> = [];
    Object.defineProperty(fixture.host.bb, "sdk", {
      configurable: true,
      get: () => ({
        threads: {
          send: (args: { threadId: string; mode: string; input: unknown[] }) => {
            const first = args.input[0] as { text: string };
            sent.push({
              threadId: args.threadId,
              mode: args.mode,
              text: first.text,
            });
            return Promise.resolve({ ok: true, delivery: "queued" });
          },
        },
      }),
    });

    expect(await fixture.runtime.remindPremise(thread)).toBe("sent");
    expect(sent).toHaveLength(1);
    // Queued, never a steer.
    expect(sent[0]?.mode).toBe("queue-if-active");
    expect(sent[0]?.text).toContain("the ladder records before it sends");

    // The watermark holds across a second drain, and across a reload: it lives
    // in the durable meta table, not in memory.
    expect(await fixture.runtime.remindPremise(thread)).toBe(
      "already-reminded",
    );
    expect(sent).toHaveLength(1);
  });

  it("says nothing on a thread with no resolved run folder", async () => {
    clock.now = T0;
    fixture = makeWatchFixture(
      { "watch_premiseReminder": true, "watch_mode": "steer" },
      clock,
    );
    await fixture.runtime.refresh();
    const thread = fixture.seedThread({ threadId: "thr-no-folder" });
    fixture.seedTurns(thread, [
      {
        turnId: "turn-1",
        seqStarted: 1,
        startedAt: -60_000,
        completedAt: -50_000,
        compacted: true,
      },
    ]);

    expect(await fixture.runtime.remindPremise(thread)).toBe("no-run-folder");
  });

  it("says nothing on a thread that has not compacted", async () => {
    clock.now = T0;
    fixture = makeWatchFixture(
      { "watch_premiseReminder": true, "watch_mode": "steer" },
      clock,
    );
    await fixture.runtime.refresh();
    const folder = seedRunFolder();
    const thread = fixture.seedThread({ threadId: "thr-plain" });
    fixture.store.upsertThread({ thread_id: thread, run_folder: folder });
    fixture.seedTurns(thread, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -60_000 },
    ]);

    expect(await fixture.runtime.remindPremise(thread)).toBe("no-compaction");
  });
});
