// Invariant: the normalize carry is as durable as the watermark.
//
// The watermark says "folded up to seq N"; the carry says what that fold left
// open — chiefly the running token baseline. Keeping one on disk and the other
// in memory meant the first usage event after a plugin reload was read as a
// delta against nothing, so an entire thread's running total was billed to
// whichever turn happened to be open.
import { describe, expect, it } from "vitest";
import { createIngest } from "../src/core/ingest.js";
import { EventStore } from "../src/core/store-events.js";
import { TempDatabase, event, makeIngestHost, tokenUsage } from "./fakes.js";

describe("carry durability", () => {
  it("resumes the token baseline in a fresh ingest over the same store", async () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      const events = new EventStore(store.db);
      const host = makeIngestHost();
      host.threads.set("thr-1", { id: "thr-1", title: "[son5:low] slice" });
      host.pages.set("thr-1", [
        event(
          1,
          "turn/started",
          { providerThreadId: "sess-1" },
          { turnId: "t1" },
        ),
        tokenUsage(2, {
          inputTokens: 100,
          cachedInputTokens: 1_000,
          outputTokens: 50,
          reasoningOutputTokens: 10,
        }),
        event(
          3,
          "turn/completed",
          { providerThreadId: "sess-1", status: "completed" },
          { turnId: "t1" },
        ),
      ]);

      await createIngest({ bb: host.bb, store, events }).drainThread("thr-1");

      // The plugin reloads: a brand new ingest, same database.
      host.pages.get("thr-1")?.push(
        event(
          4,
          "turn/started",
          { providerThreadId: "sess-1" },
          { turnId: "t2" },
        ),
        tokenUsage(5, {
          inputTokens: 180,
          cachedInputTokens: 3_000,
          outputTokens: 90,
          reasoningOutputTokens: 30,
        }),
      );
      await createIngest({ bb: host.bb, store, events }).drainThread("thr-1");

      // t2's share is the DELTA over t1's totals, not the running total.
      expect(
        store.db
          .prepare(
            "SELECT input_tokens, cached_input_tokens, output_tokens FROM obs_turn WHERE turn_id = 't2'",
          )
          .get(),
      ).toEqual({
        input_tokens: 80,
        cached_input_tokens: 2_000,
        output_tokens: 40,
      });
    } finally {
      temp.dispose();
    }
  });
});
