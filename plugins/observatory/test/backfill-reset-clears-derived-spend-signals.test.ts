// Invariant: `--reset` re-derives the spend module's signals, and only those.
//
// `obs_signal.dedupe_key` is what makes the cache-miss detector idempotent, so
// an episode opened by an older estimator survives every later scan. `--reset`
// then re-read the whole event history while the number on the cost page
// stayed frozen at whatever the first pass computed - the operator ran the one
// command built for "re-derive it with the current code" and got the old
// answer back (QA phase 1).
//
// The other half is the guard: a watch signal records what happened while a
// run was live and nothing can recompute it, so a reset that dropped it would
// destroy the only copy.
import { describe, expect, it } from "vitest";
import { createIngest } from "../src/core/ingest.js";
import { EventStore } from "../src/core/store-events.js";
import { TempDatabase, event, makeIngestHost } from "./fakes.js";

const AT = "2026-08-31T00:00:00.000Z";

describe("backfill reset", () => {
  it("clears spend signals and their actions, and leaves watch signals", async () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      const events = new EventStore(store.db);
      const host = makeIngestHost();
      host.threads.set("thr-1", { id: "thr-1", title: "[son5:low] slice" });
      host.pages.set("thr-1", [
        event(1, "thread/identity", { providerThreadId: "sess-1" }),
      ]);
      const ingest = createIngest({ bb: host.bb, store, events });
      await ingest.drainThread("thr-1");

      const spendId = store.openSignal({
        module: "spend",
        kind: "cache-miss",
        dedupeKey: "spend:cache-miss:thr-1:t1",
        threadId: "thr-1",
        turnId: "t1",
        openedAt: AT,
        payload: { estimatedUsd: 6.54 },
      });
      store.recordAction({
        signalId: spendId,
        threadId: "thr-1",
        action: "notified",
        at: AT,
      });
      store.openSignal({
        module: "watch",
        kind: "stall",
        dedupeKey: "watch:stall:thr-1:t1",
        threadId: "thr-1",
        openedAt: AT,
      });
      // A spend signal on a thread the reset does not select stays too: the
      // scope is the threads being rewound, not the module wholesale.
      store.openSignal({
        module: "spend",
        kind: "cache-miss",
        dedupeKey: "spend:cache-miss:thr-2:t1",
        threadId: "thr-2",
        openedAt: AT,
      });

      ingest.reset(["thr-1"]);

      const modules = store.db
        .prepare("SELECT module, thread_id FROM obs_signal ORDER BY id")
        .all();
      expect(modules).toEqual([
        { module: "watch", thread_id: "thr-1" },
        { module: "spend", thread_id: "thr-2" },
      ]);
      // The action rows hang off the signal, so they go with it or they are
      // orphans pointing at an id the next insert will reuse.
      expect(store.counts().actions).toBe(0);
    } finally {
      temp.dispose();
    }
  });
});
