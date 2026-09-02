// Cache-miss cost is a SHARE of the bill, so it can never be larger than it.
//
// The live 7d view reported 1,698.28 of miss cost against 1,373.18 of spend,
// which is not a rounding argument: it is a claim that the cache cost more
// than everything cost. The cause was the estimate charging the whole drop in
// cache reads at the uncached rate, whether or not that prefix was ever
// re-sent - a compaction shrinks the read precisely BECAUSE the prompt got
// smaller, so nothing was re-billed.
import { afterEach, describe, expect, it } from "vitest";
import { detectCacheMisses } from "../src/spend/cache-miss.js";
import { spendOverview, spendThread } from "../src/spend/rollup.js";
import { TempDatabase } from "./fakes.js";
import { seedThread, seedTurn, testCatalog } from "./spend-fixtures.js";

const NOW = Date.parse("2026-08-31T00:00:00.000Z");

let temp: TempDatabase | undefined;
afterEach(() => {
  temp?.dispose();
  temp = undefined;
});

describe("cache-miss cost", () => {
  it("never exceeds spend for the same scope and range", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, { thread_id: "root" });
    // A compaction: the read collapses by 119k and the next prompt is TINY,
    // so almost none of that prefix was re-sent at full price.
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t1",
      started_at: "2026-08-30T10:00:00.000Z",
      completed_at: "2026-08-30T10:00:30.000Z",
      cache_read_tokens: 120_000,
      input_tokens: 500,
      cost_usd: 0.05,
      model_reported: "test-model",
    });
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t2",
      started_at: "2026-08-30T10:01:00.000Z",
      cache_read_tokens: 1_000,
      input_tokens: 800,
      cost_usd: 0.01,
      compacted: 1,
      model_reported: "test-model",
    });
    const deps = { db: store.db, catalog: testCatalog(), now: () => NOW };

    detectCacheMisses({ ...deps, store }, { threadId: "root" });
    const overview = spendOverview(deps, { range: "7d", group: "lineage" });

    expect(overview.totals.missCostUsd).toBeGreaterThan(0);
    expect(overview.totals.missCostUsd).toBeLessThanOrEqual(
      overview.totals.spendUsd,
    );
    // The drilldown reads the same signals through the same filter, so the
    // invariant has to hold there too.
    const thread = spendThread(deps, "root").totals;
    expect(thread.missCostUsd).toBeLessThanOrEqual(thread.spendUsd);
  });

  it("estimates nothing for a miss on a turn the ledger never priced", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, { thread_id: "root" });
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t1",
      started_at: "2026-08-30T10:00:00.000Z",
      cache_read_tokens: 120_000,
      model_reported: "test-model",
    });
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t2",
      started_at: "2026-08-30T10:01:00.000Z",
      cache_read_tokens: 1_000,
      input_tokens: 119_000,
      cost_usd: null,
      model_reported: "test-model",
    });

    const rows = detectCacheMisses(
      { db: store.db, store, catalog: testCatalog(), now: () => NOW },
      { threadId: "root" },
    );

    // An unpriced turn adds nothing to spend, so it may claim nothing here.
    // `null` and not `0`: not measured is not the same as free.
    expect(rows[0]?.estimatedUsd).toBeNull();
  });
});
