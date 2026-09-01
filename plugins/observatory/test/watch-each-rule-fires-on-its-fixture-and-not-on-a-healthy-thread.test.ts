// Every rule needs BOTH halves proved. A rule that fires on its own fixture
// but also on a healthy thread is not a detector, it is an alarm — and the
// phase-3 steer ladder is gated on the precision this phase measures, so a
// false positive here becomes a wrong steer later.
import { afterEach, describe, expect, it } from "vitest";
import { evaluate } from "../src/watch/rules.js";
import { readWatchConfig } from "../src/watch/settings.js";
import { WatchQueries } from "../src/watch/queries.js";
import {
  T0,
  makeWatchFixture,
  seedHealthyThread,
  type WatchFixture,
} from "./fakes.js";

let fixture: WatchFixture;

afterEach(() => fixture?.dispose());

async function rulesFor(threadId: string): Promise<string[]> {
  const queries = new WatchQueries(fixture.db);
  const snapshot = queries.snapshot(threadId, T0)!;
  const config = await readWatchConfig(fixture.host.bb, fixture.settingValues);
  return evaluate(snapshot, config).map((finding) => finding.rule);
}

describe("each watch rule", () => {
  it("silence-no-inflight fires after the threshold and not before", async () => {
    fixture = makeWatchFixture();
    const thread = fixture.seedThread({ threadId: "thr-silent" });
    fixture.seedTurns(thread, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -600_000, completedAt: -600_000 },
    ]);
    // Last activity five minutes ago, nothing in flight: over the 4 minute bar.
    fixture.seedItems(thread, [
      { seq: 2, kind: "toolCall", startedAt: -300_000, completedAt: -300_000 },
    ]);

    expect(await rulesFor(thread)).toContain("silence-no-inflight");
    expect(await rulesFor(seedHealthyThread(fixture))).not.toContain(
      "silence-no-inflight",
    );
  });

  it("repeated-identical-tool fires on three identical fingerprints in twenty", async () => {
    fixture = makeWatchFixture();
    const thread = fixture.seedThread({ threadId: "thr-loop" });
    fixture.seedTurns(thread, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -60_000 },
    ]);
    fixture.seedItems(
      thread,
      [2, 3, 4, 5].map((seq) => ({
        seq,
        kind: "toolCall",
        name: "Bash",
        fingerprint: "fp-ls",
        startedAt: -50_000 + seq * 1_000,
        completedAt: -49_000 + seq * 1_000,
      })),
    );

    expect(await rulesFor(thread)).toContain("repeated-identical-tool");
    expect(await rulesFor(seedHealthyThread(fixture))).not.toContain(
      "repeated-identical-tool",
    );
  });

  it("repeated-identical-tool stays quiet when the same tool takes different input", async () => {
    fixture = makeWatchFixture();
    const thread = fixture.seedThread({ threadId: "thr-varied" });
    fixture.seedTurns(thread, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -60_000 },
    ]);
    fixture.seedItems(
      thread,
      [2, 3, 4, 5].map((seq) => ({
        seq,
        kind: "toolCall",
        name: "Bash",
        fingerprint: `fp-${seq}`,
        startedAt: -50_000 + seq * 1_000,
        completedAt: -49_000 + seq * 1_000,
      })),
    );

    expect(await rulesFor(thread)).not.toContain("repeated-identical-tool");
  });

  it("read-edit-read fires on two cycles and a command between them clears it", async () => {
    fixture = makeWatchFixture();
    const thread = fixture.seedThread({ threadId: "thr-osc" });
    fixture.seedTurns(thread, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -60_000 },
    ]);
    // R E R E R on one path is two cycles.
    const kinds = ["fileRead", "fileChange", "fileRead", "fileChange", "fileRead"];
    fixture.seedItems(
      thread,
      kinds.map((kind, index) => ({
        seq: index + 2,
        kind,
        path: "src/a.ts",
        startedAt: -50_000 + index * 1_000,
        completedAt: -49_500 + index * 1_000,
      })),
    );
    expect(await rulesFor(thread)).toContain("read-edit-read");

    // The same shape with a command in the middle is an agent that checked its
    // work, not one that is flailing.
    fixture.dispose();
    fixture = makeWatchFixture();
    const calm = fixture.seedThread({ threadId: "thr-osc-calm" });
    fixture.seedTurns(calm, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -60_000 },
    ]);
    const withCommand = [
      "fileRead",
      "fileChange",
      "fileRead",
      "commandExecution",
      "fileChange",
      "fileRead",
    ];
    fixture.seedItems(
      calm,
      withCommand.map((kind, index) => ({
        seq: index + 2,
        kind,
        path: kind === "commandExecution" ? null : "src/a.ts",
        startedAt: -50_000 + index * 1_000,
        completedAt: -49_500 + index * 1_000,
      })),
    );
    expect(await rulesFor(calm)).not.toContain("read-edit-read");
  });

  it("active-no-turn measures from the last turn's END, not its start", async () => {
    fixture = makeWatchFixture();
    const thread = fixture.seedThread({ threadId: "thr-longturn" });
    // Forty minutes of thinking that finished one second ago. Measured from
    // the START that reads as a forty-minute idle thread; it is nothing of
    // the kind, and steering it would interrupt work that just landed.
    fixture.seedTurns(thread, [
      {
        turnId: "turn-1",
        seqStarted: 1,
        startedAt: -40 * 60_000,
        completedAt: -1_000,
      },
    ]);

    expect(await rulesFor(thread)).not.toContain("active-no-turn");
  });

  it("active-no-turn fires when the last turn ended over ten minutes ago", async () => {
    fixture = makeWatchFixture();
    const thread = fixture.seedThread({ threadId: "thr-noturn" });
    fixture.seedTurns(thread, [
      {
        turnId: "turn-1",
        seqStarted: 1,
        startedAt: -11 * 60_000,
        completedAt: -11 * 60_000,
      },
    ]);

    expect(await rulesFor(thread)).toContain("active-no-turn");
    expect(await rulesFor(seedHealthyThread(fixture))).not.toContain(
      "active-no-turn",
    );
  });

  it("burn-no-change fires past 150k tokens with no file change", async () => {
    fixture = makeWatchFixture();
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
      { seq: 2, kind: "toolCall", fingerprint: "a", startedAt: -30_000, completedAt: -29_000 },
    ]);

    expect(await rulesFor(thread)).toContain("burn-no-change");
    expect(await rulesFor(seedHealthyThread(fixture))).not.toContain(
      "burn-no-change",
    );
  });

  it("retry-storm fires on three retrying errors inside the window", async () => {
    fixture = makeWatchFixture();
    const thread = fixture.seedThread({ threadId: "thr-retry" });
    fixture.seedTurns(
      thread,
      [1, 2, 3].map((n) => ({
        turnId: `turn-${n}`,
        seqStarted: n,
        startedAt: -120_000 * n,
        completedAt: -120_000 * n + 1_000,
        errorCategory: "overloaded",
        willRetry: true,
      })),
    );

    expect(await rulesFor(thread)).toContain("retry-storm");
    expect(await rulesFor(seedHealthyThread(fixture))).not.toContain(
      "retry-storm",
    );
  });

  it("retry-storm ignores errors that fell out of the ten minute window", async () => {
    fixture = makeWatchFixture();
    const thread = fixture.seedThread({ threadId: "thr-old-retry" });
    fixture.seedTurns(
      thread,
      [1, 2, 3].map((n) => ({
        turnId: `turn-${n}`,
        seqStarted: n,
        startedAt: -60 * 60_000 - n * 1_000,
        completedAt: -60 * 60_000 - n * 1_000,
        errorCategory: "overloaded",
        willRetry: true,
      })),
    );

    expect(await rulesFor(thread)).not.toContain("retry-storm");
  });

  it("tree-budget fires over the per-tree ceiling and not under it", async () => {
    fixture = makeWatchFixture();
    const thread = fixture.seedThread({ threadId: "thr-spend" });
    fixture.seedTurns(thread, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -60_000, costUsd: 51 },
    ]);
    expect(await rulesFor(thread)).toContain("tree-budget");

    fixture.dispose();
    fixture = makeWatchFixture();
    const cheap = fixture.seedThread({ threadId: "thr-cheap" });
    fixture.seedTurns(cheap, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -60_000, costUsd: 1 },
    ]);
    expect(await rulesFor(cheap)).not.toContain("tree-budget");
  });

  it("tree-budget re-arms on a doubling and not on every dollar after", async () => {
    // Subtree spend only ever grows, so an anchor of "this root" would fire
    // once and stay open forever. The anchor carries the doubling band: one
    // signal at the ceiling, the next at twice it, nothing in between.
    fixture = makeWatchFixture();
    const thread = fixture.seedThread({ threadId: "thr-doubling" });

    async function treeEpisode(): Promise<string | undefined> {
      const queries = new WatchQueries(fixture.db);
      const snapshot = queries.snapshot(thread, T0)!;
      const config = await readWatchConfig(
        fixture.host.bb,
        fixture.settingValues,
      );
      return evaluate(snapshot, config).find(
        (finding) =>
          finding.rule === "tree-budget" && finding.episode.startsWith("tree:"),
      )?.episode;
    }

    // $51 against the $50 ceiling.
    fixture.seedTurns(thread, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -60_000, costUsd: 51 },
    ]);
    const first = await treeEpisode();
    expect(first).toBe(`tree:${thread}:0`);

    // Creeping up to $99 is the SAME crossing: no new episode.
    fixture.seedTurns(thread, [
      { turnId: "turn-2", seqStarted: 2, startedAt: -30_000, costUsd: 48 },
    ]);
    expect(await treeEpisode()).toBe(first);

    // Past $100 the spend has doubled, and that is worth saying again.
    fixture.seedTurns(thread, [
      { turnId: "turn-3", seqStarted: 3, startedAt: -10_000, costUsd: 10 },
    ]);
    expect(await treeEpisode()).toBe(`tree:${thread}:1`);
  });

  it("skips a rule whose enable flag is off", async () => {
    fixture = makeWatchFixture({ "watch_repeatedIdenticalTool_enabled": false });
    const thread = fixture.seedThread({ threadId: "thr-loop-off" });
    fixture.seedTurns(thread, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -60_000 },
    ]);
    fixture.seedItems(
      thread,
      [2, 3, 4].map((seq) => ({
        seq,
        kind: "toolCall",
        fingerprint: "fp-ls",
        startedAt: -50_000 + seq * 1_000,
        completedAt: -49_000 + seq * 1_000,
      })),
    );

    expect(await rulesFor(thread)).not.toContain("repeated-identical-tool");
  });

  it('keeps a rule on when its flag round-trips as the string "true"', async () => {
    // Settings come back from the host as strings as often as booleans, and
    // reading anything but `true` as off silently disabled a rule nobody had
    // touched. Only an explicit false turns one off.
    fixture = makeWatchFixture({
      "watch_repeatedIdenticalTool_enabled": "true",
    });
    const thread = fixture.seedThread({ threadId: "thr-loop-on" });
    fixture.seedTurns(thread, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -60_000 },
    ]);
    fixture.seedItems(
      thread,
      [2, 3, 4].map((seq) => ({
        seq,
        kind: "toolCall",
        fingerprint: "fp-ls",
        startedAt: -50_000 + seq * 1_000,
        completedAt: -49_000 + seq * 1_000,
      })),
    );

    expect(await rulesFor(thread)).toContain("repeated-identical-tool");
  });

  it("leaves an idle thread alone even when it has been quiet for hours", async () => {
    fixture = makeWatchFixture();
    const thread = fixture.seedThread({
      threadId: "thr-idle",
      status: "idle",
    });
    fixture.seedTurns(thread, [
      {
        turnId: "turn-1",
        seqStarted: 1,
        startedAt: -6 * 60 * 60_000,
        completedAt: -6 * 60 * 60_000,
      },
    ]);

    const rules = await rulesFor(thread);
    expect(rules).not.toContain("silence-no-inflight");
    expect(rules).not.toContain("active-no-turn");
  });
});
