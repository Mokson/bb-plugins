// Invariant: bb's provider id is not the log's provider id, and the join
// still finds the rows. bb calls it `pi` while the indexer stored the rows
// under `bb-pi-bridge`; bb calls it `acp-omp` while the rows say `omp`.
// Joining on bb's id alone left both providers permanently unavailable.
import { describe, expect, it } from "vitest";
import { joinPendingTurns, logProvidersFor } from "../src/core/join.js";
import { JoinHarness, row } from "./join-harness.js";

const TURNS = [
  {
    id: "t1",
    started: "2026-09-01T10:00:00.000Z",
    completed: "2026-09-01T10:00:10.000Z",
  },
];

describe("the provider alias table", () => {
  it("joins a pi thread to bb-pi-bridge rows", () => {
    const harness = new JoinHarness(TURNS, "pi");
    try {
      const rows = [
        row({ key: "a", at: "2026-09-01T10:00:03.000Z", provider: "bb-pi-bridge" }),
        row({ key: "b", at: "2026-09-01T10:00:08.000Z", provider: "bb-pi-bridge" }),
      ];
      const summary = joinPendingTurns(harness.deps(rows));
      expect(summary.unavailable).toBe(0);
      expect(summary.rows).toBe(2);
      expect(harness.turnRow("t1")["split_source"]).toBe("log-window");
    } finally {
      harness.dispose();
    }
  });

  it("joins an acp-omp thread to omp rows", () => {
    const harness = new JoinHarness(TURNS, "acp-omp");
    try {
      const rows = [
        row({ key: "a", at: "2026-09-01T10:00:03.000Z", provider: "omp" }),
      ];
      const summary = joinPendingTurns(harness.deps(rows));
      expect(summary.unavailable).toBe(0);
      expect(summary.rows).toBe(1);
    } finally {
      harness.dispose();
    }
  });

  it("prefers the bridge but falls back to pi's own id", () => {
    expect(logProvidersFor("pi")).toEqual(["bb-pi-bridge", "pi"]);
    expect(logProvidersFor("claude-code")).toEqual(["claude-code"]);
    expect(logProvidersFor("something-new")).toEqual(["something-new"]);
  });
});
