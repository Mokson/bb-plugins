// The rule the whole rollup exists to hold. `SUM()` in sqlite skips NULLs, so
// a group with one unproven split would otherwise report the reads it happens
// to know as if they were the reads that happened — a made-up number under a
// confident heading on the cost page.
//
// The repair for that is a floor, not a null: a partial group reports the
// proven sum AND `cacheReadPartial`, so every surface renders `90,000+`.
// Nulling on the first unknown descendant was its own defect (QA phase 1, H1):
// in a 47-agent run every aggregate row read `--` while the reads it dropped
// were still being counted into `tokens_total`. Only a group with no proven
// split left is unknown.
import { afterEach, describe, expect, it } from "vitest";
import { spendOverview } from "../src/spend/rollup.js";
import { TempDatabase } from "./fakes.js";
import { seedThread, seedTurn, testCatalog } from "./spend-fixtures.js";

const NOW = Date.parse("2026-08-31T00:00:00.000Z");

let temp: TempDatabase | undefined;
afterEach(() => {
  temp?.dispose();
  temp = undefined;
});

describe("spend rollup", () => {
  it("reports the proven sum with a partial flag when one turn is unproven", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, { thread_id: "root", title: "run" });
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t1",
      cache_read_tokens: 90_000,
      cache_write_tokens: 5_000,
      cost_usd: 1,
      cost_source: "logged",
    });
    // The turn that makes the group unknowable.
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t2",
      cache_read_tokens: null,
      cache_write_tokens: null,
      split_source: "unavailable",
      cost_usd: 2,
      cost_source: "catalog",
    });

    const { rows } = spendOverview(
      { db: store.db, catalog: testCatalog(), now: () => NOW },
      { range: "7d", group: "lineage" },
    );
    const root = rows.find((row) => row.key === "root");

    // A floor, flagged as one - not a total, and not a discarded measurement.
    expect(root?.cacheReadTokens).toBe(90_000);
    expect(root?.cacheReadPartial).toBe(true);
    expect(root?.cacheWriteTokens).toBe(5_000);
    expect(root?.cacheWritePartial).toBe(true);
    // The columns that ARE knowable stay numbers: nulling everything would be
    // the opposite failure.
    expect(root?.turns).toBe(2);
    expect(root?.costUsd).toBe(3);
    // One catalog-priced turn is enough to mark the whole group estimated.
    expect(root?.estimated).toBe(true);
  });

  it("reports null only when no turn in the group has a proven split", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, { thread_id: "root", title: "run" });
    for (const turnId of ["t1", "t2"]) {
      seedTurn(store, {
        thread_id: "root",
        turn_id: turnId,
        cache_read_tokens: null,
        cache_write_tokens: null,
        split_source: "unavailable",
        cost_usd: 1,
        cost_source: "logged",
      });
    }

    const { rows } = spendOverview(
      { db: store.db, catalog: testCatalog(), now: () => NOW },
      { range: "7d", group: "lineage" },
    );
    const root = rows.find((row) => row.key === "root");

    expect(root?.cacheReadTokens).toBeNull();
    expect(root?.cacheWriteTokens).toBeNull();
    // No `+` on a cell that has nothing to be a floor over.
    expect(root?.cacheReadPartial).toBe(false);
    expect(root?.cacheWritePartial).toBe(false);
  });

  it("reports the sum once every turn's split is proven", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, { thread_id: "root" });
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t1",
      cache_read_tokens: 10,
      cache_write_tokens: 1,
      cost_usd: 1,
      cost_source: "logged",
    });
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t2",
      cache_read_tokens: 20,
      cache_write_tokens: 2,
      cost_usd: 1,
      cost_source: "logged",
    });

    const { rows } = spendOverview(
      { db: store.db, now: () => NOW },
      { range: "7d", group: "lineage" },
    );

    expect(rows[0]?.cacheReadTokens).toBe(30);
    expect(rows[0]?.cacheWriteTokens).toBe(3);
    expect(rows[0]?.estimated).toBe(false);
  });

  it("leaves cost null rather than zero when nothing in the group is priced", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, { thread_id: "root" });
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t1",
      cost_usd: null,
      cost_source: "unknown",
    });

    const { rows, totals } = spendOverview(
      { db: store.db, now: () => NOW },
      { range: "7d", group: "lineage" },
    );

    // `$0.00` reads as free; `n/a` reads as unmeasured, and only one is true.
    expect(rows[0]?.costUsd).toBeNull();
    expect(totals.unpricedModels).toBe(1);
  });
});
