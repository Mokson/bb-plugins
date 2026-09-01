// Invariant: `rejoinPending` drains the pending queue rather than joining one
// page of it. The queue is capped per call and ordered oldest first, so a
// single pass over a ledger with more unjoined turns than the cap left the
// NEWEST turns - the ones anyone is actually looking at - unattributed
// forever. Measured on the real ledger: 73% coverage on one pass, 97% drained.
import { describe, expect, it } from "vitest";
import { createIngest } from "../src/core/ingest.js";
import type { LogTurn } from "../src/core/join.js";
import { EventStore } from "../src/core/store-events.js";
import { TempDatabase, makeIngestHost } from "./fakes.js";

const PAGE = 500;
const TURNS = PAGE + 120;

describe("rejoinPending", () => {
  it("keeps going while a pass still proves new splits", () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      const events = new EventStore(store.db);
      store.upsertThread({
        thread_id: "thr-1",
        provider_id: "claude-code",
        provider_thread_id: "sess-1",
      });

      const rows: LogTurn[] = [];
      for (let index = 0; index < TURNS; index += 1) {
        const start = Date.parse("2026-09-01T00:00:00.000Z") + index * 60_000;
        store.upsertTurn({
          thread_id: "thr-1",
          turn_id: `t${String(index).padStart(4, "0")}`,
          started_at: new Date(start).toISOString(),
          completed_at: new Date(start + 30_000).toISOString(),
          input_tokens: 10,
          cached_input_tokens: 110,
          output_tokens: 5,
          split_source: "unavailable",
        });
        rows.push({
          log_key: `claude-code:sess-1:${index}`,
          provider: "claude-code",
          provider_thread_id: "sess-1",
          ts: start + 5_000,
          model: "claude-opus-5",
          input: 10,
          cache_read: 100,
          cache_write: 10,
          output: 5,
          reasoning: 0,
          logged_cost_usd: null,
          is_sidechain: 0,
          agent_id: null,
          skill_names: null,
          mcp_names: null,
        });
      }

      const ingest = createIngest({
        bb: makeIngestHost().bb,
        store,
        events,
        logs: { listLogTurns: () => rows.slice() },
        priceTurn: () => ({
          costUsd: 1,
          costSource: "catalog",
          pricingStatus: "exact",
          cacheSavingsUsd: 0,
        }),
        catalog: null,
      });

      const summary = ingest.rejoinPending();

      expect(summary?.unavailable).toBe(0);
      expect(events.coverage().logExact).toBe(TURNS);
    } finally {
      temp.dispose();
    }
  });

  it("stops instead of spinning when a pass proves nothing", () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      const events = new EventStore(store.db);
      store.upsertThread({
        thread_id: "thr-1",
        provider_id: "claude-code",
        provider_thread_id: "sess-1",
      });
      store.upsertTurn({
        thread_id: "thr-1",
        turn_id: "t1",
        started_at: "2026-09-01T10:00:00.000Z",
        completed_at: "2026-09-01T10:00:10.000Z",
        split_source: "unavailable",
      });

      const ingest = createIngest({
        bb: makeIngestHost().bb,
        store,
        events,
        // An unavailable turn stays pending forever; the loop must not.
        logs: { listLogTurns: () => [] },
        priceTurn: () => ({
          costUsd: null,
          costSource: null,
          pricingStatus: "unknown",
          cacheSavingsUsd: null,
        }),
        catalog: null,
      });

      expect(ingest.rejoinPending()).toMatchObject({ unavailable: 1 });
    } finally {
      temp.dispose();
    }
  });
});
