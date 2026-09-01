// Invariant: the realtime signal decides WHAT to drain, and only for changes
// that can carry ledger rows. Draining on every thread:changed would re-read
// the tail of every thread on a pin toggle.
import { describe, expect, it } from "vitest";
import { createIngest } from "../src/core/ingest.js";
import { EventStore } from "../src/core/store-events.js";
import { TempDatabase, event, makeIngestHost } from "./fakes.js";

describe("subscribe to dirty set", () => {
  it("queues a thread whose changed event names ledger event types", async () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      const events = new EventStore(store.db);
      const host = makeIngestHost();
      host.threads.set("thr-1", { id: "thr-1" });
      host.pages.set("thr-1", [
        event(1, "turn/started", { providerThreadId: "sess-1" }, { turnId: "t1" }),
      ]);

      const ingest = createIngest({ bb: host.bb, store, events });
      const controller = new AbortController();
      const running = ingest.start(controller.signal);

      host.emitChanged({
        id: "thr-1",
        changes: ["events-appended"],
        metadata: { eventTypes: ["turn/started"] },
      });
      expect(ingest.counters().dirty).toBe(1);

      // A change that carries no ledger event types is ignored.
      host.emitChanged({
        id: "thr-2",
        changes: ["pin-state-changed"],
        metadata: { eventTypes: ["thread/name/updated"] },
      });
      expect(ingest.counters().dirty).toBe(1);

      await ingest.drainOnce();
      expect(ingest.counters().dirty).toBe(0);
      expect(store.counts().turns).toBe(1);

      controller.abort();
      await running;
    } finally {
      temp.dispose();
    }
  });
});
