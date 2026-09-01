// Invariant: replaying a page changes nothing. The realtime signal is a hint
// and bb can repeat it, so every drain must be safe to run twice — the
// watermark plus primary-key upserts are what make that true.
import { describe, expect, it } from "vitest";
import { createIngest } from "../src/core/ingest.js";
import { EventStore } from "../src/core/store-events.js";
import { TempDatabase, event, makeIngestHost, tokenUsage } from "./fakes.js";

describe("drain replay", () => {
  it("leaves the same rows and counts after a second pass", async () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      const events = new EventStore(store.db);
      const host = makeIngestHost();
      host.threads.set("thr-1", { id: "thr-1", title: "[son5:low] slice" });
      host.pages.set("thr-1", [
        event(1, "thread/identity", { providerThreadId: "sess-1" }),
        event(2, "turn/started", { providerThreadId: "sess-1" }, { turnId: "t1" }),
        event(
          3,
          "item/completed",
          {
            providerThreadId: "sess-1",
            item: { type: "toolCall", id: "i1", tool: "bash", arguments: { command: "ls" }, status: "completed" },
          },
          { turnId: "t1" },
        ),
        tokenUsage(4, {
          inputTokens: 100,
          cachedInputTokens: 1_000,
          outputTokens: 50,
          reasoningOutputTokens: 0,
        }),
        event(5, "turn/completed", { providerThreadId: "sess-1", status: "completed" }, { turnId: "t1" }),
      ]);

      const ingest = createIngest({ bb: host.bb, store, events });
      ingest.markDirty("thr-1");
      await ingest.drainOnce();
      const first = store.counts();
      const turnBefore = store.db
        .prepare("SELECT * FROM obs_turn WHERE turn_id = 't1'")
        .get();

      // Same thread marked dirty again: bb repeated the signal.
      ingest.markDirty("thr-1");
      await ingest.drainOnce();

      expect(store.counts()).toEqual(first);
      expect(
        store.db.prepare("SELECT * FROM obs_turn WHERE turn_id = 't1'").get(),
      ).toEqual(turnBefore);
      expect(first).toMatchObject({ threads: 1, turns: 1, items: 1 });
      // The second drain resumed from the watermark rather than page one.
      expect(host.listCalls.at(-1)?.afterSeq).toBe("5");
      expect(events.watermark("thr-1")).toBe(5);
    } finally {
      temp.dispose();
    }
  });
});
