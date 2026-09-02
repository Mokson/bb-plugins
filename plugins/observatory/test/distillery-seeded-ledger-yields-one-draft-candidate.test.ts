// Criterion c14: a seeded ledger with three nudges of one cause-class across
// two runs yields exactly ONE draft candidate cluster.
//
// This is the module's motivating scenario end to end: real ledger bytes on
// disk, through the scanners, the store, the clustering and the batch
// selection, to the set of clusters a drafting batch would carry. Nothing is
// spawned and nothing is applied.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TempDatabase } from "./fakes.js";
import { DistilleryRuntime } from "../src/distillery/queue.js";
import { readDistilleryConfig } from "../src/distillery/settings.js";
import { selectBatch } from "../src/distillery/draft.js";

const temps: TempDatabase[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const temp of temps.splice(0)) temp.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function seedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "distillery-c14-"));
  dirs.push(root);
  return root;
}

function writeLedger(root: string, run: string, nudges: string[]): string {
  const folder = join(root, "repo", "docs", "specs", run);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "LEDGER.md"),
    ["goal: seeded", "", "## nudges", ...nudges, "", "## runlog", ""].join("\n"),
    "utf8",
  );
  return folder;
}

/** One phrasing of one failure. Reused so the three nudges cluster. */
const THE_FAILURE =
  "the packet checkpoint was breached without requesting an orchestrator ack";

/** A second, unrelated failure, so "exactly one" is a real constraint. */
const OTHER_FAILURE =
  "provider session logs were rediscovered by probing instead of reading docs";

function runtimeOver(improvementsDir: string) {
  const temp = new TempDatabase();
  temps.push(temp);
  const db = temp.openDatabase();
  const config = readDistilleryConfig({
    distillery_improvementsDir: improvementsDir,
  });
  const runtime = new DistilleryRuntime({
    // Only `log` is reached during a scan; the scanners take their inputs
    // explicitly rather than off `bb`.
    bb: { log: { warn: () => {}, info: () => {}, error: () => {} } } as never,
    db,
    config: () => config,
    now: () => new Date("2026-09-01T12:00:00Z"),
  });
  return { runtime, config };
}

describe("a seeded ledger yields exactly one draft candidate cluster", () => {
  it("clusters three nudges of one cause-class across two runs into one candidate", () => {
    const root = seedRoot();
    const improvements = join(root, "improvements");
    mkdirSync(improvements, { recursive: true });

    // Three nudges of ONE cause class, spread across TWO runs: two in the
    // first, one in the second. The spread is what clears the runs bar.
    const runA = writeLedger(root, "run-a", [
      `- n1 | packet-contract | ${THE_FAILURE} | -`,
      `- n2 | packet-contract | ${THE_FAILURE} | 1 dispatch`,
    ]);
    const runB = writeLedger(root, "run-b", [
      `- n1 | packet-contract | ${THE_FAILURE} | -`,
      // A second failure seen ONCE. It must not become a candidate.
      `- n2 | discovery-cost | ${OTHER_FAILURE} | -`,
    ]);

    const { runtime, config } = runtimeOver(improvements);
    const counts = runtime.scan(runA);
    const countsB = runtime.scan(runB);

    expect(counts.bySource["ledger-nudge"]).toBe(2);
    expect(countsB.bySource["ledger-nudge"]).toBe(2);

    const clusters = runtime.clusters();
    const qualifying = clusters.filter((cluster) => cluster.qualifies);

    // Exactly one candidate: the repeated failure. The once-seen one is a
    // cluster, but it does not qualify.
    expect(qualifying).toHaveLength(1);
    const [candidate] = qualifying;
    expect(candidate?.causeClass).toBe("packet-contract");
    expect(candidate?.size).toBe(3);
    expect(candidate?.runs).toBe(2);

    // And that is exactly what a drafting batch would carry.
    const batch = selectBatch(clusters, runtime.store, []);
    expect(batch.map((cluster) => cluster.id)).toEqual([candidate?.id]);

    // Status agrees with the CLI's view of the same numbers.
    const status = runtime.status();
    expect(status.clusters).toBe(clusters.length);
    expect(status.topClusters[0]?.size).toBe(3);
    expect(status.budgetUsd).toBe(config.monthlyBudgetUsd);
  });

  it("re-scanning the same ledger adds nothing and moves no threshold", () => {
    const root = seedRoot();
    const improvements = join(root, "improvements");
    const runA = writeLedger(root, "run-a", [
      `- n1 | packet-contract | ${THE_FAILURE} | -`,
    ]);
    writeLedger(root, "run-b", [
      `- n1 | packet-contract | ${THE_FAILURE} | -`,
    ]);

    const { runtime } = runtimeOver(improvements);
    runtime.scan();
    const first = runtime.clusters();
    const inserted = runtime.scan().inserted;

    // Idempotent: a second pass over unchanged bytes must not inflate a
    // cluster's size and push it over the bar on its own.
    expect(inserted).toBe(0);
    const second = runtime.clusters();
    expect(second.map((c) => [c.id, c.size, c.runs])).toEqual(
      first.map((c) => [c.id, c.size, c.runs]),
    );
    expect(runA).toContain("run-a");
  });

  it("keeps an off-taxonomy cause class rather than dropping the nudge", () => {
    // Real ledgers carry tags the retro taxonomy does not list. Dropping them
    // would throw away the highest-precision field on the best source.
    const root = seedRoot();
    const folder = writeLedger(root, "run-a", [
      `- n1 | tooling-guard | ${THE_FAILURE} | -`,
    ]);
    const { runtime } = runtimeOver(join(root, "improvements"));
    runtime.scan(folder);
    const stored = runtime.store.corrections();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.causeClass).toBe("tooling-guard");
    // ...at a slightly lower confidence, because it cannot be cross-referenced
    // against the retro corpus.
    expect(stored[0]?.confidence).toBeCloseTo(0.8, 5);
  });
});
