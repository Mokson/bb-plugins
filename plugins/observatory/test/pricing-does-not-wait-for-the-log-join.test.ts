// Invariant: a turn bb has already reported tokens and a model for carries a
// price the moment it is ingested.
//
// Pricing used to live only inside `joinSession`, so a turn's cost waited on
// a five-minute join pass AND on a resolved provider session. A freshly
// spawned thread therefore showed `split_source = unavailable` with a NULL
// cost, NULL `pricing_status` and NULL `model_reported` for as long as either
// was missing - which for a thread whose provider session never resolves is
// forever. The split can stay unknown; the bill cannot.
import { describe, expect, it } from "vitest";
import { createIngest } from "../src/core/ingest.js";
import { bundledCatalog } from "../src/core/catalog.js";
import { priceTurn, priceTurnPort } from "../src/core/pricing.js";
import { EventStore } from "../src/core/store-events.js";
import { TempDatabase, event, makeIngestHost, tokenUsage } from "./fakes.js";

const USAGE = {
  inputTokens: 1_000,
  cachedInputTokens: 110_000,
  outputTokens: 2_000,
  reasoningOutputTokens: 0,
};

describe("a turn drained before any join runs", () => {
  it("is priced from bb's own totals, with no log rows at all", async () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      const events = new EventStore(store.db);
      const host = makeIngestHost();
      host.threads.set("thr-1", { id: "thr-1", providerId: "claude-code" });
      host.pages.set("thr-1", [
        event(1, "client/turn/requested", {
          execution: { model: "claude-opus-5" },
        }),
        event(2, "turn/started", {}, { turnId: "t1" }),
        tokenUsage(3, USAGE, { turnId: "t1" }),
        event(4, "turn/completed", { status: "completed" }, { turnId: "t1" }),
      ]);

      const ingest = createIngest({
        bb: host.bb,
        store,
        events,
        // No `logs`: this is the case where the join has nothing to say.
        priceTurn: priceTurnPort(() => bundledCatalog()),
        catalog: bundledCatalog(),
      });
      await ingest.drainThread("thr-1");

      const turn = store.db
        .prepare("SELECT * FROM obs_turn WHERE turn_id = 't1'")
        .get() as Record<string, unknown>;
      expect(turn["pricing_status"]).toBe("exact");
      expect(turn["cost_source"]).toBe("catalog");
      expect(turn["cost_usd"]).toBeCloseTo(
        priceTurn(
          {
            provider: "claude-code",
            model: "claude-opus-5",
            inputTokens: USAGE.inputTokens,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            cachedInputTokens: USAGE.cachedInputTokens,
            outputTokens: USAGE.outputTokens,
            reasoningTokens: 0,
            loggedCostUsd: null,
          },
          bundledCatalog(),
        ).costUsd!,
        10,
      );
      // The split is still unproven, and saying otherwise is the one thing
      // this plugin must never do.
      expect(turn["split_source"]).toBe("unavailable");
      expect(turn["cache_read_tokens"]).toBeNull();
      expect(turn["cache_savings_usd"]).toBeNull();
    } finally {
      temp.dispose();
    }
  });

  it("leaves an already-priced turn alone on the next drain", async () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      const events = new EventStore(store.db);
      const host = makeIngestHost();
      host.threads.set("thr-1", { id: "thr-1", providerId: "claude-code" });
      host.pages.set("thr-1", [
        event(1, "turn/started", {}, { turnId: "t1" }),
        tokenUsage(2, USAGE, { turnId: "t1" }),
        event(3, "turn/completed", { status: "completed" }, { turnId: "t1" }),
      ]);
      const ingest = createIngest({
        bb: host.bb,
        store,
        events,
        priceTurn: priceTurnPort(() => bundledCatalog()),
        catalog: bundledCatalog(),
      });
      await ingest.drainThread("thr-1");

      // No model was ever requested, so there is no price to be had. The
      // status still records that verdict, which is what keeps the turn out
      // of the queue on every later drain.
      const turn = store.db
        .prepare("SELECT * FROM obs_turn WHERE turn_id = 't1'")
        .get() as Record<string, unknown>;
      expect(turn["pricing_status"]).toBe("unknown");
      expect(turn["cost_usd"]).toBeNull();
      expect(events.listTurnsPendingPrice("thr-1")).toEqual([]);
    } finally {
      temp.dispose();
    }
  });
});
