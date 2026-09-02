// The cause is a CONVENTION over evidence, not a measurement: nothing can diff
// the prompt prefix. So the two things that must hold are that the order is
// respected when several correlates coincide, and that every correlate stays
// in the drilldown regardless of which one won.
import { afterEach, describe, expect, it } from "vitest";
import { CAUSE_ORDER, detectCacheMisses } from "../src/spend/cache-miss.js";
import type { ObservatoryStore } from "../src/core/store.js";
import { TempDatabase } from "./fakes.js";
import { seedLogTurn, seedThread, seedTurn, testCatalog } from "./spend-fixtures.js";

const NOW = Date.parse("2026-08-31T00:00:00.000Z");
const FIRST = "2026-08-30T10:00:00.000Z";
const FIRST_END = "2026-08-30T10:00:30.000Z";
const SECOND = "2026-08-30T10:01:00.000Z";

let temp: TempDatabase | undefined;
afterEach(() => {
  temp?.dispose();
  temp = undefined;
});

/**
 * Two turns one minute apart on one thread, the second having lost its cached
 * prefix: 120k reads down to 1k, which clears both the ratio and the absolute
 * thresholds. The third turn keeps the pair off the thread's FIRST position,
 * so `first-turn` does not silently win every assertion.
 */
function seedDrop(
  store: ObservatoryStore,
  options: { compacted?: boolean; modelSwitch?: boolean } = {},
): void {
  seedThread(store, { thread_id: "root", title: "run" });
  seedTurn(store, {
    thread_id: "root",
    turn_id: "t0",
    started_at: "2026-08-30T09:59:00.000Z",
    completed_at: "2026-08-30T09:59:30.000Z",
    cache_read_tokens: 120_000,
    model_reported: "test-model",
  });
  seedTurn(store, {
    thread_id: "root",
    turn_id: "t1",
    started_at: FIRST,
    completed_at: FIRST_END,
    cache_read_tokens: 120_000,
    // The switch is staged on the EARLIER turn so the turn being priced still
    // resolves in the catalog; an unpriceable model would hide the estimate.
    model_reported: options.modelSwitch ? "other-model" : "test-model",
  });
  seedTurn(store, {
    thread_id: "root",
    turn_id: "t2",
    started_at: SECOND,
    cache_read_tokens: 1_000,
    // The prefix really was re-sent and really was billed: the estimate is a
    // share of THIS turn's input and cost, never of the drop alone.
    input_tokens: 119_000,
    cost_usd: 0.5,
    model_reported: "test-model",
    compacted: options.compacted ? 1 : 0,
  });
}

function detect(store: ObservatoryStore) {
  return detectCacheMisses(
    { db: store.db, store, catalog: testCatalog(), now: () => NOW },
    { threadId: "root" },
  );
}

describe("cache-miss classification", () => {
  it("prefers compaction over every later correlate that also fired", () => {
    temp = new TempDatabase();
    const store = temp.open();
    // Compaction, a model switch and a skill injection all in one gap.
    seedDrop(store, { compacted: true, modelSwitch: true });
    seedLogTurn(store, {
      threadId: "root",
      turnId: "t1",
      logKey: "log-1",
      skillNames: ["implement"],
    });
    seedLogTurn(store, {
      threadId: "root",
      turnId: "t2",
      logKey: "log-2",
      skillNames: ["implement", "refine"],
    });

    const rows = detect(store);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.cause).toBe("compaction");
    // The drilldown keeps everything observed, not only the classified one.
    const kinds = rows[0]?.correlates.map((entry) => entry.kind) ?? [];
    expect(kinds).toContain("model-switch");
    expect(kinds).toContain("skill-injection");
  });

  it("falls to model-switch when no earlier correlate is present", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedDrop(store, { modelSwitch: true });

    expect(detect(store)[0]?.cause).toBe("model-switch");
  });

  it("falls to skill-injection when only the skill list grew", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedDrop(store);
    seedLogTurn(store, {
      threadId: "root",
      turnId: "t1",
      logKey: "log-1",
      skillNames: ["implement"],
    });
    seedLogTurn(store, {
      threadId: "root",
      turnId: "t2",
      logKey: "log-2",
      skillNames: ["implement", "refine"],
    });

    expect(detect(store)[0]?.cause).toBe("skill-injection");
  });

  it("classifies an idle gap past the TTL before any later correlate", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedDrop(store);
    // The gap is 30 seconds, so a half-second TTL expires the prefix.
    const rows = detectCacheMisses(
      {
        db: store.db,
        store,
        catalog: testCatalog(),
        ttlMinutes: 0.005,
        now: () => NOW,
      },
      { threadId: "root" },
    );

    expect(rows[0]?.cause).toBe("idle-expiry");
  });

  it("carries the provider and a priced estimate for the dropped tokens", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedDrop(store, { modelSwitch: true });

    const row = detect(store)[0];

    expect(row?.provider).toBe("claude-code");
    // 119k tokens repriced from the 0.3 cache-read rate to the 3.0 input rate.
    expect(row?.estimatedUsd).toBeCloseTo((119_000 * 2.7) / 1_000_000, 10);
  });

  it("never emits a cause outside the declared order", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedDrop(store, { compacted: true, modelSwitch: true });

    for (const row of detect(store)) {
      expect(CAUSE_ORDER).toContain(row.cause);
    }
  });

  it("ignores a drop it cannot prove, because an unknown read is not a drop", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, { thread_id: "root" });
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t1",
      started_at: FIRST,
      cache_read_tokens: 120_000,
    });
    seedTurn(store, {
      thread_id: "root",
      turn_id: "t2",
      started_at: SECOND,
      cache_read_tokens: null,
      split_source: "unavailable",
    });

    expect(detect(store)).toHaveLength(0);
  });
});
