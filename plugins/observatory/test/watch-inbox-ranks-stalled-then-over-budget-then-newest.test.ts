// The inbox is the panel's landing page, so its order IS the product: the row
// a person needs must never sit under one they do not. Stalled work is losing
// time right now, an over-budget tree is losing money but is not blocked, and
// everything else is ranked by recency.
//
// The comparator is deliberately generic. Audit, eval and distillery land
// against this same list, and none of them should require editing the sort.
import { afterEach, describe, expect, it } from "vitest";
import { buildInbox } from "../src/watch/views.js";
import { makeWatchFixture, type WatchFixture } from "./fakes.js";

let fixture: WatchFixture;

afterEach(() => fixture?.dispose());

function open(
  f: WatchFixture,
  options: {
    module: string;
    kind: string;
    threadId: string;
    openedAt: string;
    severity?: string;
    evidence?: string;
  },
): void {
  f.seedThread({ threadId: options.threadId, status: "active" });
  f.store.openSignal({
    module: options.module,
    kind: options.kind,
    dedupeKey: `${options.threadId}:${options.kind}:1`,
    threadId: options.threadId,
    severity: options.severity ?? "warn",
    openedAt: options.openedAt,
    payload: { evidence: options.evidence ?? `${options.kind} evidence` },
  });
}

describe("the attention inbox", () => {
  it("ranks stalled first, then over budget, then newest", () => {
    fixture = makeWatchFixture();
    // Seeded oldest-first so recency cannot accidentally produce the answer.
    open(fixture, {
      module: "watch",
      kind: "silence-no-inflight",
      threadId: "thr-stalled",
      openedAt: "2026-09-01T09:00:00.000Z",
    });
    open(fixture, {
      module: "watch",
      kind: "tree-budget",
      threadId: "thr-budget",
      openedAt: "2026-09-01T10:00:00.000Z",
      severity: "critical",
    });
    open(fixture, {
      module: "spend",
      kind: "cache-miss",
      threadId: "thr-spend-old",
      openedAt: "2026-09-01T11:00:00.000Z",
    });
    open(fixture, {
      module: "spend",
      kind: "prefix-changed",
      threadId: "thr-spend-new",
      openedAt: "2026-09-01T13:00:00.000Z",
    });

    const { rows, counts } = buildInbox(fixture.runtime.queries, 50);

    expect(rows.map((row) => row.threadId)).toEqual([
      "thr-stalled",
      "thr-budget",
      // Within the last band, newest first.
      "thr-spend-new",
      "thr-spend-old",
    ]);
    expect(rows[0]!.source).toBe("watch");
    expect(rows[0]!.actions).toEqual(["open", "steer"]);
    // A budget row is escalated, not steered: steering the stalled thread
    // would not spend less.
    expect(rows[1]!.actions).toEqual(["open", "escalate"]);
    expect(rows[2]!.source).toBe("spend");
    expect(rows[2]!.actions).toEqual(["open", "review"]);

    expect(counts).toEqual({
      watched: 4,
      stalled: 1,
      overBudget: 1,
      queue: 4,
    });
  });

  it("puts the evidence line in the subtitle", () => {
    fixture = makeWatchFixture();
    open(fixture, {
      module: "watch",
      kind: "repeated-identical-tool",
      threadId: "thr-loop",
      openedAt: "2026-09-01T12:00:00.000Z",
      evidence: "8 of the last 20 items repeat Bash with identical input",
    });

    const { rows } = buildInbox(fixture.runtime.queries, 50);
    expect(rows[0]!.subtitle).toBe(
      "8 of the last 20 items repeat Bash with identical input",
    );
    expect(rows[0]!.title).toBe("repeated identical tool");
  });

  it("drops a closed signal and honours the limit", () => {
    fixture = makeWatchFixture();
    open(fixture, {
      module: "watch",
      kind: "silence-no-inflight",
      threadId: "thr-a",
      openedAt: "2026-09-01T12:00:00.000Z",
    });
    open(fixture, {
      module: "watch",
      kind: "burn-no-change",
      threadId: "thr-b",
      openedAt: "2026-09-01T12:30:00.000Z",
    });
    expect(buildInbox(fixture.runtime.queries, 1).rows).toHaveLength(1);
    // The count is the whole queue, not the page.
    expect(buildInbox(fixture.runtime.queries, 1).counts.queue).toBe(2);

    const first = fixture.runtime.queries.openSignals("thr-a")[0]!;
    fixture.store.closeSignal(first.id, "2026-09-01T13:00:00.000Z");

    const after = buildInbox(fixture.runtime.queries, 50);
    expect(after.rows.map((row) => row.threadId)).toEqual(["thr-b"]);
    expect(after.counts.queue).toBe(1);
  });

  it("renders an empty inbox as an empty list, not a crash", () => {
    fixture = makeWatchFixture();
    const { rows, counts } = buildInbox(fixture.runtime.queries, 50);
    expect(rows).toEqual([]);
    expect(counts).toEqual({ watched: 0, stalled: 0, overBudget: 0, queue: 0 });
  });
});
