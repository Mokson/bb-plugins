// Two refusals that must happen BEFORE a hidden thread is spawned:
//
//  - the monthly drafting budget is spent, and
//  - the cluster is already covered by a written improvement or a register row.
//
// Both are checked against a fake SDK whose `spawn` records every call, so the
// assertion is "nothing was spawned", not "the function returned early".
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TempDatabase } from "./fakes.js";
import { DistilleryStore } from "../src/distillery/store.js";
import {
  DRAFT_THREAD_TAG,
  dedupeCorpus,
  isAlreadyCovered,
  monthSpendUsd,
  operationIdFor,
  runDraftBatch,
  selectBatch,
} from "../src/distillery/draft.js";
import { readDistilleryConfig } from "../src/distillery/settings.js";
import type { Cluster } from "../src/distillery/cluster.js";
import type { Database } from "better-sqlite3";

const temps: TempDatabase[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const temp of temps.splice(0)) temp.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-09-15T12:00:00Z");
const SIGNATURE =
  "packet-contract|acknowledgement breached checkpoint orchestrator packet requesting";

function cluster(id = "cluster1"): Cluster {
  return {
    id,
    signature: SIGNATURE,
    causeClass: "packet-contract",
    size: 3,
    runs: 2,
    firstAt: "2026-09-01T00:00:00.000Z",
    lastAt: "2026-09-10T00:00:00.000Z",
    status: "open",
    qualifies: true,
    members: [
      {
        id: 1,
        source: "ledger-nudge",
        signature: "sig#n1",
        causeClass: "packet-contract",
        preview: "checkpoint breached without requesting an orchestrator ack",
        redactionCounts: {},
        runFolder: "/repo/docs/specs/run-a",
        threadId: null,
        at: "2026-09-01T00:00:00.000Z",
        confidence: 0.9,
        clusterId: null,
      },
    ],
  };
}

/** A fake SDK that records spawns instead of making them. */
function fakeBb(spawns: unknown[]) {
  return {
    log: { warn: () => {}, info: () => {}, error: () => {} },
    sdk: {
      threads: {
        list: async () => ({ threads: [] }),
        spawn: async (args: unknown) => {
          spawns.push(args);
          return { id: "thr-spawned" };
        },
        events: { wait: async () => null },
        output: async () => ({ output: '{"drafts":[]}' }),
      },
    },
  } as never;
}

function freshDb(): Database {
  const temp = new TempDatabase();
  temps.push(temp);
  return temp.openDatabase();
}

/** Bill a drafting thread `cost` dollars inside the current month. */
function seedDraftingSpend(db: Database, cost: number, at: string): void {
  db.prepare(
    "INSERT INTO obs_thread (thread_id, title, project_id, last_seen_at) VALUES (?, ?, ?, ?)",
  ).run("thr-draft", `${DRAFT_THREAD_TAG} draft batch abc`, "proj-1", at);
  db.prepare(
    "INSERT INTO obs_turn (thread_id, turn_id, started_at, cost_usd) VALUES (?, ?, ?, ?)",
  ).run("thr-draft", "turn-1", at, cost);
}

describe("drafting never spawns over budget or over covered ground", () => {
  it("counts only this month's drafting threads toward the budget", () => {
    const db = freshDb();
    seedDraftingSpend(db, 4.5, "2026-09-02T00:00:00.000Z");
    // A thread from LAST month, and a non-drafting thread this month: neither
    // may count against the budget.
    db.prepare(
      "INSERT INTO obs_thread (thread_id, title, last_seen_at) VALUES (?, ?, ?)",
    ).run("thr-old", `${DRAFT_THREAD_TAG} draft batch old`, "2026-08-01");
    db.prepare(
      "INSERT INTO obs_turn (thread_id, turn_id, started_at, cost_usd) VALUES (?, ?, ?, ?)",
    ).run("thr-old", "t", "2026-08-02T00:00:00.000Z", 99);
    db.prepare(
      "INSERT INTO obs_thread (thread_id, title, last_seen_at) VALUES (?, ?, ?)",
    ).run("thr-other", "a normal thread", "2026-09-02");
    db.prepare(
      "INSERT INTO obs_turn (thread_id, turn_id, started_at, cost_usd) VALUES (?, ?, ?, ?)",
    ).run("thr-other", "t", "2026-09-02T00:00:00.000Z", 50);

    expect(monthSpendUsd(db, NOW)).toBeCloseTo(4.5, 5);
  });

  it("spawns nothing once the month's spend reaches the budget", async () => {
    const db = freshDb();
    const store = new DistilleryStore(db);
    seedDraftingSpend(db, 10, "2026-09-02T00:00:00.000Z");
    const spawns: unknown[] = [];

    const result = await runDraftBatch(
      {
        bb: fakeBb(spawns),
        db,
        store,
        config: readDistilleryConfig({ distillery_monthlyBudgetUsd: "10" }),
        runFolders: [],
        now: () => NOW,
      },
      [cluster()],
    );

    expect(spawns).toHaveLength(0);
    expect(result.threadId).toBeNull();
    expect(result.skipped).toMatch(/budget spent/);
    // And no draft was invented in place of the one it did not pay for.
    expect(store.drafts()).toHaveLength(0);
  });

  it("spawns when there is budget left", async () => {
    const db = freshDb();
    const store = new DistilleryStore(db);
    seedDraftingSpend(db, 1, "2026-09-02T00:00:00.000Z");
    const spawns: Array<Record<string, unknown>> = [];

    const result = await runDraftBatch(
      {
        bb: fakeBb(spawns),
        db,
        store,
        config: readDistilleryConfig({ distillery_monthlyBudgetUsd: "10" }),
        runFolders: [],
        now: () => NOW,
      },
      [cluster()],
    );

    expect(spawns).toHaveLength(1);
    expect(result.threadId).toBe("thr-spawned");
    // Pinned, hidden, and titled with the operation id that makes the spawn
    // exactly-once.
    expect(spawns[0]?.visibility).toBe("hidden");
    expect(spawns[0]?.providerId).toBe("claude-code");
    expect(spawns[0]?.model).toBe("claude-sonnet-5");
    expect(spawns[0]?.reasoningLevel).toBe("low");
    expect(String(spawns[0]?.title)).toContain(DRAFT_THREAD_TAG);
    expect(String(spawns[0]?.title)).toContain(
      operationIdFor([cluster().id]),
    );

    // The prompt carries the redacted preview and nothing off disk.
    expect(String(spawns[0]?.prompt)).toContain(
      "checkpoint breached without requesting an orchestrator ack",
    );
    expect(String(spawns[0]?.prompt)).toContain("STRICT JSON");
  });

  it("skips a cluster an existing improvements file already covers", () => {
    const root = mkdtempSync(join(tmpdir(), "distillery-dedupe-"));
    dirs.push(root);
    const improvements = join(root, "improvements");
    mkdirSync(improvements, { recursive: true });
    writeFileSync(
      join(improvements, "2026-08-20_checkpoint-acks.md"),
      [
        "# packet-contract: checkpoint acknowledgement",
        "",
        "Seats breached the checkpoint without requesting an orchestrator",
        "acknowledgement. The packet now fails on an un-acked breach.",
      ].join("\n"),
      "utf8",
    );

    const corpus = dedupeCorpus(improvements, []);
    expect(corpus).toHaveLength(1);
    expect(isAlreadyCovered(SIGNATURE, corpus)).toBe(true);

    const store = new DistilleryStore(freshDb());
    expect(selectBatch([cluster()], store, corpus)).toHaveLength(0);
    // Without the corpus, the very same cluster IS selected — so the test is
    // measuring the dedupe and not some other refusal.
    expect(selectBatch([cluster()], store, [])).toHaveLength(1);
  });

  it("skips a cluster a repo findings register already covers", () => {
    const root = mkdtempSync(join(tmpdir(), "distillery-dedupe-reg-"));
    dirs.push(root);
    const repo = join(root, "repo");
    mkdirSync(join(repo, ".agents", "retro"), { recursive: true });
    writeFileSync(
      join(repo, ".agents", "retro", "FINDINGS.md"),
      "| F-1 | 2026-08-01 | seats breached the checkpoint without requesting an orchestrator acknowledgement | packet-contract | proposed | handoffs.md | none | pending |\n",
      "utf8",
    );

    const corpus = dedupeCorpus(join(root, "nope"), [
      join(repo, "docs", "specs", "run-a"),
    ]);
    expect(isAlreadyCovered(SIGNATURE, corpus)).toBe(true);
  });

  it("never re-batches a cluster that already has a draft", () => {
    const store = new DistilleryStore(freshDb());
    store.insertDraft(
      {
        id: "d1",
        clusterId: "cluster1",
        state: "rejected",
        homeFile: null,
        rung: null,
        patchUnifiedDiff: null,
        ruleText: null,
        successSignal: null,
        rationale: "unparseable",
        evidenceIds: [],
        recurrence: 2,
        threadId: null,
      },
      NOW.toISOString(),
    );
    // Even a REJECTED draft stops the re-batch: otherwise a reply that never
    // parses is paid for on every run, forever.
    expect(selectBatch([cluster()], store, [])).toHaveLength(0);
  });
});
