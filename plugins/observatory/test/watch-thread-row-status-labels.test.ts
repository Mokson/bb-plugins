// The thread row carries one label, so two open signals on one thread have to
// resolve to a single word pair. Budget wins: it is the one with a hard number
// attached, and a thread that is both is costing money either way.
import { describe, expect, it } from "vitest";
import {
  labelsByThread,
  statusLabelForKind,
} from "../src/app/lib/watch/thread-row-status.js";
import type { WatchSignalRow } from "../src/watch/contract.js";

let nextSignalId = 0;

function signal(
  threadId: string | null,
  kind: string,
  closedAt: string | null = null,
): WatchSignalRow {
  return {
    id: (nextSignalId += 1),
    threadId,
    kind,
    severity: "warn",
    openedAt: "2026-09-01T09:00:00.000Z",
    closedAt,
    evidence: "evidence",
    payload: {},
  };
}

describe("the thread row status label", () => {
  it("reads over budget for a budget rule and stalled for everything else", () => {
    expect(statusLabelForKind("tree-budget")).toBe("over budget");
    expect(statusLabelForKind("budget_perDayUsd")).toBe("over budget");
    expect(statusLabelForKind("silence-no-inflight")).toBe("stalled");
    expect(statusLabelForKind("repeated-identical-tool")).toBe("stalled");
  });

  it("gives over budget precedence when one thread has both", () => {
    const labels = labelsByThread([
      signal("thr_1", "silence-no-inflight"),
      signal("thr_1", "tree-budget"),
    ]);
    expect(labels.get("thr_1")).toBe("over budget");
    expect(labels.size).toBe(1);
  });

  it("keeps threads independent", () => {
    const labels = labelsByThread([
      signal("thr_1", "tree-budget"),
      signal("thr_2", "silence-no-inflight"),
    ]);
    expect([...labels]).toEqual([
      ["thr_1", "over budget"],
      ["thr_2", "stalled"],
    ]);
  });

  it("ignores a closed signal, so a cleared thread loses its status", () => {
    const labels = labelsByThread([
      signal("thr_1", "tree-budget", "2026-09-01T09:05:00.000Z"),
    ]);
    expect(labels.size).toBe(0);
  });
});
