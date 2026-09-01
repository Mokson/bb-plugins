// The drafting threshold: size >= 2 AND runs >= 2.
//
// Both halves matter and they fail differently. Size alone would draft from a
// single anecdote; runs alone is unreachable. The pair that actually bites is
// two hits inside ONE run — one root cause counted twice by two sources — and
// that case must NOT qualify.
import { describe, expect, it } from "vitest";
import {
  MIN_CLUSTER_RUNS,
  MIN_CLUSTER_SIZE,
  clusterCorrections,
  normalizeSignature,
} from "../src/distillery/cluster.js";
import type { CorrectionView } from "../src/distillery/contract.js";

let nextId = 1;

function correction(
  preview: string,
  runFolder: string | null,
  causeClass: string | null = "tooling-gap",
): CorrectionView {
  return {
    id: nextId++,
    source: "ledger-nudge",
    signature: `ledger-nudge:${causeClass}:x`,
    causeClass,
    preview,
    redactionCounts: {},
    runFolder,
    threadId: null,
    at: `2026-08-0${(nextId % 9) + 1}T00:00:00.000Z`,
    confidence: 0.9,
    clusterId: null,
  };
}

const FAILURE =
  "the packet checkpoint was breached without an ack from the orchestrator";

describe("a cluster qualifies at size 2 across 2 runs", () => {
  it("does not qualify on one hit", () => {
    const [cluster] = clusterCorrections([correction(FAILURE, "/repo/run-a")]);
    expect(cluster?.size).toBe(1);
    expect(cluster?.runs).toBe(1);
    expect(cluster?.qualifies).toBe(false);
  });

  it("does not qualify on two hits inside one run", () => {
    // Two sources describing one root cause in a single run is exactly the
    // double-count the `runs` half of the threshold exists to reject.
    const [cluster] = clusterCorrections([
      correction(FAILURE, "/repo/run-a"),
      correction(FAILURE, "/repo/run-a"),
    ]);
    expect(cluster?.size).toBe(2);
    expect(cluster?.runs).toBe(1);
    expect(cluster?.qualifies).toBe(false);
  });

  it("qualifies at two hits across two runs", () => {
    const [cluster] = clusterCorrections([
      correction(FAILURE, "/repo/run-a"),
      correction(FAILURE, "/repo/run-b"),
    ]);
    expect(cluster?.size).toBe(MIN_CLUSTER_SIZE);
    expect(cluster?.runs).toBe(MIN_CLUSTER_RUNS);
    expect(cluster?.qualifies).toBe(true);
  });

  it("never counts an unattributed correction toward the run bar", () => {
    // A transcript guess carries no run folder. Letting it count would let one
    // unattributed source clear a bar meant to prove independent trials.
    const [cluster] = clusterCorrections([
      correction(FAILURE, null),
      correction(FAILURE, null),
    ]);
    expect(cluster?.size).toBe(2);
    expect(cluster?.runs).toBe(0);
    expect(cluster?.qualifies).toBe(false);
  });

  it("groups reorderings and renumberings, and separates different failures", () => {
    // The signature is order-free and number-free by construction: the numbers
    // are what VARY between two instances of one failure, and two people
    // describing it pick the same nouns in a different order.
    //
    // It is not synonym-tolerant: the shingle is a fixed-width window over the
    // sorted vocabulary, so a genuinely different WORD set makes a different
    // cluster. That is the conservative direction to fail in — a split cluster
    // stays below the threshold and drafts nothing, where a wrongly merged one
    // would draft a fix for two unrelated failures.
    const a = normalizeSignature(
      "packet-contract",
      "the seat ran 56 tool uses against a 35-use checkpoint without an ack",
    );
    const b = normalizeSignature(
      "packet-contract",
      "without an ack: checkpoint 30, uses 41, the seat ran tool uses against it",
    );
    expect(a).toBe(b);

    const different = normalizeSignature(
      "packet-contract",
      "the reviewer packet omitted the context digest written after the draft",
    );
    expect(different).not.toBe(a);
  });

  it("keeps a cause class the majority of members agree on", () => {
    const [cluster] = clusterCorrections([
      correction(FAILURE, "/repo/run-a", "tooling-gap"),
      correction(FAILURE, "/repo/run-b", "tooling-gap"),
    ]);
    expect(cluster?.causeClass).toBe("tooling-gap");
  });
});
