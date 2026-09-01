// Invariant: `provider_thread_id` survives every later drain.
//
// Only the event stream carries it — the thread DTO does not — so the registry
// row rebuilt on each tick cannot supply it. When that row was written as a
// FULL column list it nulled the column on every drain, which left the whole
// ledger unable to join a single bb turn to its provider log.
import { describe, expect, it } from "vitest";
import { createIngest } from "../src/core/ingest.js";
import { EventStore } from "../src/core/store-events.js";
import { TempDatabase, event, makeIngestHost } from "./fakes.js";

describe("provider thread id", () => {
  it("is still set after a drain that sees no identity event", async () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      const events = new EventStore(store.db);
      const host = makeIngestHost();
      host.threads.set("thr-1", { id: "thr-1", title: "[son5:low] slice" });
      host.pages.set("thr-1", [
        event(1, "thread/identity", { providerThreadId: "sess-1" }),
        event(
          2,
          "turn/started",
          { providerThreadId: "sess-1" },
          { turnId: "t1" },
        ),
      ]);

      const ingest = createIngest({ bb: host.bb, store, events });
      await ingest.drainThread("thr-1");
      expect(
        store.db
          .prepare("SELECT provider_thread_id FROM obs_thread")
          .get(),
      ).toEqual({ provider_thread_id: "sess-1" });

      // The second drain resumes past the identity event, so the page is
      // empty and only the registry row is written.
      await ingest.drainThread("thr-1");

      expect(
        store.db
          .prepare("SELECT provider_thread_id FROM obs_thread")
          .get(),
      ).toEqual({ provider_thread_id: "sess-1" });
      // The watermark the registry row cannot know is intact too.
      expect(events.watermark("thr-1")).toBe(2);
    } finally {
      temp.dispose();
    }
  });
});
