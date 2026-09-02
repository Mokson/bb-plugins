// The motivating scenario, end to end: a deliver run has finished, and the
// question is what it cost and where. That path crosses the ingest commit
// hook, the lineage rollup, the CLI rendering, the export, and COST.md, so it
// is exercised here as one story rather than five units.
import { afterEach, describe, expect, it } from "vitest";
import { createIngest } from "../src/core/ingest.js";
import { EventStore } from "../src/core/store-events.js";
import { detectCacheMisses } from "../src/spend/cache-miss.js";
import {
  formatOverview,
  spendExport,
  spendOverview,
  spendThread,
  spendToday,
} from "../src/spend/rollup.js";
import { spendOverviewSchema, spendThreadSchema } from "../src/spend/contract.js";
import { buildCostMd } from "../src/spend/cost-md.js";
import { TempDatabase, event, makeIngestHost } from "./fakes.js";
import { COST_MD_NOW, LEDGER, RUN_FOLDER, seedCostMdRun } from "./cost-md-fixture.js";
import { seedThread, seedTurn, testCatalog } from "./spend-fixtures.js";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");

let temp: TempDatabase | undefined;
afterEach(() => {
  temp?.dispose();
  temp = undefined;
});

describe("a finished deliver run", () => {
  it("rolls up by lineage, seat and unparented bucket, and renders the same numbers", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedCostMdRun(store);
    // A thread whose root never resolved. It is still real money, so it gets
    // its own bucket rather than quietly vanishing from the total.
    seedThread(store, { thread_id: "orphan", root_thread_id: null });
    seedTurn(store, {
      thread_id: "orphan",
      turn_id: "o0",
      cost_usd: 0.13,
      cost_source: "logged",
      cache_read_tokens: 5,
      cache_write_tokens: 1,
    });

    const deps = { db: store.db, catalog: testCatalog(), now: () => NOW };
    const overview = spendOverview(deps, { range: "7d", group: "lineage" });

    // The rpc validates its output before it ships, so a shape the panel
    // cannot read fails here rather than in the browser.
    expect(spendOverviewSchema.parse(overview)).toEqual(overview);

    const root = overview.rows.find((row) => row.key === "impl");
    expect(root).toMatchObject({ depth: 0, kind: "thread", childCount: 1 });
    // The root row carries its subtree: two of its own turns plus the probe's.
    expect(root?.turns).toBe(3);
    expect(root?.costUsd).toBeCloseTo(1.55, 10);

    const orphan = overview.rows.find((row) => row.kind === "unparented");
    expect(orphan).toMatchObject({ key: "unparented", childCount: 1 });
    expect(overview.totals.spendUsd).toBeCloseTo(2.0, 10);

    // Every row the object carries reaches the text, at its own depth.
    const text = formatOverview(overview);
    expect(text).toContain("deliver-qa");
    expect(text).toContain("unparented");
    expect(text).toContain("spend            2.0000");
  });

  it("nests a seat between a root and its children when the child carries one", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, { thread_id: "root", title: "run" });
    seedThread(store, {
      thread_id: "child",
      title: "[son5:low] deliver-qa row 1",
      seat: "deliver-qa",
      parent_thread_id: "root",
      root_thread_id: "root",
      depth: 1,
    });
    seedTurn(store, { thread_id: "root", turn_id: "a", cost_usd: 1, cost_source: "logged" });
    seedTurn(store, { thread_id: "child", turn_id: "b", cost_usd: 2, cost_source: "logged" });

    const rows = spendOverview({ db: store.db, now: () => NOW }, {
      range: "7d",
      group: "lineage",
    }).rows;

    expect(rows.map((row) => [row.kind, row.depth, row.key])).toEqual([
      ["thread", 0, "root"],
      ["seat", 1, "root:seat:deliver-qa"],
      ["thread", 2, "child"],
    ]);
    expect(rows[1]?.parentKey).toBe("root");
    expect(rows[2]?.parentKey).toBe("root:seat:deliver-qa");
  });

  it("groups by model and by day off the same filtered set", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedCostMdRun(store);
    const deps = { db: store.db, now: () => NOW };

    const models = spendOverview(deps, { range: "7d", group: "model" }).rows;
    const days = spendOverview(deps, { range: "7d", group: "day" }).rows;

    expect(models.map((row) => row.kind)).toEqual(
      models.map(() => "model" as const),
    );
    expect(models.map((row) => row.key).sort()).toEqual([
      "claude-haiku-5",
      "claude-opus-5",
      "claude-sonnet-5",
    ]);
    expect(days).toHaveLength(1);
    expect(days[0]).toMatchObject({ kind: "day", key: "2026-08-30" });
  });

  it("serves one thread's per-turn split, and today's spend", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedCostMdRun(store);
    const deps = { db: store.db, now: () => NOW };

    const view = spendThread(deps, "qa");

    expect(spendThreadSchema.parse(view)).toEqual(view);
    expect(view.thread.seat).toBe("deliver-qa");
    expect(view.turns).toHaveLength(12);
    // The one turn that ran on a model nobody asked for is flagged.
    expect(view.turns[0]?.flags).toContain("mismatch");
    expect(view.turns[1]?.flags).not.toContain("mismatch");

    // Nothing was seeded at today's date, so today is honestly empty.
    expect(spendToday(deps)).toMatchObject({ spendUsd: 0, turns: 0 });
  });

  it("exports the same overview as markdown or json", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedCostMdRun(store);
    const deps = { db: store.db, now: () => NOW };

    const markdown = spendExport(deps, {
      range: "7d",
      group: "model",
      format: "md",
    });
    const json = spendExport(deps, {
      range: "7d",
      group: "model",
      format: "json",
    });

    expect(markdown.filename).toBe("spend-7d-model-2026-08-31.md");
    expect(markdown.content).toContain(
      "| row | kind | turns | input | cache read | output | cost usd | estimated |",
    );
    expect(json.filename).toBe("spend-7d-model-2026-08-31.json");
    expect(JSON.parse(json.content)).toEqual(
      spendOverview(deps, { range: "7d", group: "model" }),
    );
  });

  it("writes a COST.md whose totals agree with the lineage rollup", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedCostMdRun(store);
    const deps = { db: store.db, now: () => COST_MD_NOW };

    const report = buildCostMd(store.db, {
      runFolder: RUN_FOLDER,
      now: () => COST_MD_NOW,
      readLedger: () => LEDGER,
    });
    const overview = spendOverview(deps, {
      range: "7d",
      group: "lineage",
      runFolder: RUN_FOLDER,
    });

    // The rollup filter sees only the folder's own threads; COST.md also
    // descends into their subagents, so it is the larger of the two.
    expect(report.content).toContain("cost_usd_total: 1.8700");
    expect(overview.totals.spendUsd).toBeCloseTo(1.82, 10);
    expect(report.agents).toBe(11);
  });
});

describe("the ingest commit hook", () => {
  it("fires after a thread's turns land, and swallows a hook that throws", async () => {
    temp = new TempDatabase();
    const store = temp.open();
    const host = makeIngestHost();
    host.threads.set("t1", { id: "t1" });
    host.pages.set("t1", [
      event(1, "turn/started", {}, { turnId: "turn-1" }),
      event(2, "turn/completed", {}, { turnId: "turn-1" }),
    ]);
    const committed: string[] = [];

    const ingest = createIngest({
      bb: host.bb,
      store,
      events: new EventStore(store.db),
      onThreadCommitted: (threadId) => {
        committed.push(threadId);
        // An analyzer that throws must not be able to stall the drain loop
        // every other module is fed by.
        throw new Error("analyzer exploded");
      },
    });
    ingest.markDirty("t1");

    await expect(ingest.drainOnce()).resolves.toBeGreaterThan(0);
    expect(committed).toEqual(["t1"]);
    // The thread is NOT re-queued: the drain itself succeeded.
    expect(ingest.counters().dirty).toBe(0);
  });

  it("runs the detector on the freshly committed thread", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, { thread_id: "root" });
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t1",
      started_at: "2026-08-30T10:00:00.000Z",
      completed_at: "2026-08-30T10:00:30.000Z",
      cache_read_tokens: 120_000,
      model_reported: "other-model",
    });
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t2",
      started_at: "2026-08-30T10:01:00.000Z",
      cache_read_tokens: 1_000,
      // The re-sent prefix and the bill for it. A miss costs only what the
      // turn actually paid full input price for, so a turn with no input
      // tokens and no cost leaves the estimate nothing to be a share of.
      input_tokens: 119_000,
      cost_usd: 0.5,
      model_reported: "test-model",
    });

    detectCacheMisses(
      { db: store.db, store, catalog: testCatalog(), now: () => NOW },
      { threadId: "root" },
    );

    // The miss cost reaches the overview totals through the signal payload...
    const deps = { db: store.db, catalog: testCatalog(), now: () => NOW };
    const totals = spendOverview(deps, { range: "7d", group: "lineage" }).totals;
    expect(totals.missCostUsd).toBeGreaterThan(0);
    // ...and the thread drilldown computes its totals through the same path,
    // so no field on that page is a placeholder zero.
    expect(spendThread(deps, "root").totals.missCostUsd).toBe(
      totals.missCostUsd,
    );
  });
});
