// `observatory_trajectory` is read by a model, not a person. The SDK truncates
// tool output at 4096 characters, and a render truncated mid-row would hand
// the model a corrupt last line, so the renderer owns its own ceiling and
// drops whole rows from the middle — keeping the header and the waste line,
// which are the two parts that carry the conclusion.
import { afterEach, describe, expect, it } from "vitest";
import {
  TRAJECTORY_MAX_CHARS,
  createTrajectory,
} from "../src/watch/trajectory.js";
import { makeWatchFixture, type WatchFixture } from "./fakes.js";

let fixture: WatchFixture;

afterEach(() => fixture?.dispose());

describe("the trajectory tool", () => {
  it("marks a looping, oscillating and compacted turn", () => {
    fixture = makeWatchFixture();
    const thread = fixture.seedThread({ threadId: "thr-traj" });
    fixture.seedTurns(thread, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -300_000, inputTokens: 1_000 },
      { turnId: "turn-2", seqStarted: 10, startedAt: -200_000, inputTokens: 50_000 },
      { turnId: "turn-3", seqStarted: 20, startedAt: -100_000, inputTokens: 1_000 },
      {
        turnId: "turn-4",
        seqStarted: 30,
        startedAt: -50_000,
        inputTokens: 1_000,
        compacted: true,
      },
    ]);
    // turn-2 loops on one fingerprint; turn-3 oscillates on one path.
    fixture.seedItems(thread, [
      ...[11, 12, 13].map((seq) => ({
        seq,
        kind: "toolCall",
        fingerprint: "fp-ls",
        startedAt: -200_000 + seq,
        completedAt: -199_000 + seq,
        turnId: "turn-2",
      })),
      ...["fileRead", "fileChange", "fileRead"].map((kind, index) => ({
        seq: 21 + index,
        kind,
        path: "src/a.ts",
        startedAt: -100_000 + index,
        completedAt: -99_000 + index,
        turnId: "turn-3",
      })),
    ]);

    const text = createTrajectory({ db: fixture.db }).render(thread);
    const lines = text.split("\n");

    expect(lines[0]).toContain("turns 4");
    expect(lines[3]).toContain("LOOP");
    expect(lines[4]).toContain("OSCILLATION");
    expect(lines[5]).toContain("CONTEXT RESET");
    // turn-1 is clean, so it carries no marker.
    expect(lines[2]!.trim().endsWith("0")).toBe(true);
    // 52k of 53k tokens sit in marked turns.
    expect(text).toMatch(/waste: 52k of 53k tokens \(98%\)/);
  });

  it("stays under the tool output ceiling for a very long run", () => {
    fixture = makeWatchFixture();
    const thread = fixture.seedThread({ threadId: "thr-long" });
    fixture.seedTurns(
      thread,
      Array.from({ length: 400 }, (_, index) => ({
        turnId: `turn-${index}`,
        seqStarted: index,
        startedAt: -index * 1_000,
        inputTokens: 1_000,
      })),
    );

    const text = createTrajectory({ db: fixture.db }).render(thread);
    expect(text.length).toBeLessThanOrEqual(TRAJECTORY_MAX_CHARS);
    // The head and the conclusion survive; the middle is elided.
    expect(text.split("\n")[0]).toContain("turns 400");
    expect(text).toContain("elided");
    expect(text.trimEnd().split("\n").at(-1)).toMatch(/^waste:/);
  });

  it("reads a bounded window of a huge run and cuts only whole rows", () => {
    // The render runs on a SYNCHRONOUS database handle, so an unbounded read
    // of a long-lived thread blocks every other query to build rows that the
    // 4096-character ceiling was always going to throw away. Only the tail is
    // read, and every line that survives is a complete row: a half-written
    // last line is data a model would read as fact.
    fixture = makeWatchFixture();
    const thread = fixture.seedThread({ threadId: "thr-huge" });
    fixture.seedTurns(
      thread,
      Array.from({ length: 2_000 }, (_, index) => ({
        turnId: `turn-${index}`,
        seqStarted: index,
        startedAt: -index * 1_000,
        inputTokens: 1_000,
      })),
    );

    const text = createTrajectory({ db: fixture.db }).render(thread);
    const lines = text.split("\n");

    expect(text.length).toBeLessThanOrEqual(TRAJECTORY_MAX_CHARS);
    // Four hundred read, not two thousand, and the totals say so.
    expect(lines[0]).toContain("turns 400");
    expect(text).toContain("of 400k tokens");
    // Every turn row still carries all four columns.
    for (const line of lines.filter((row) => /^\d/.test(row))) {
      expect(line).toMatch(/^\d+\s+\d+k\s+\d+\s+\d+/);
    }
    expect(lines.at(-1)).toMatch(/^waste:/);
  });

  it("says so plainly when a thread has no turns", () => {
    fixture = makeWatchFixture();
    const text = createTrajectory({ db: fixture.db }).render("thr-unknown");
    expect(text).toBe("no turns recorded for thr-unknown");
  });
});
