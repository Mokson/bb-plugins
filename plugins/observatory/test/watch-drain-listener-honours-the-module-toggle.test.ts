// Watch has two triggers and one off switch. The sweep asks `ctx.enabled()`
// every minute; the drain listener cannot, because it is synchronous and the
// toggle is a promise. Left unchecked it kept evaluating and publishing for a
// module the operator had already turned off, which is the one thing a toggle
// has to mean. The flag is cached at setup and refreshed by the sweep.
import { describe, expect, it } from "vitest";
import type { Ingest } from "../src/core/ingest.js";
import { createWatchModule, type WatchHandle } from "../src/watch/module.js";
import { makeHarness } from "./fakes.js";

/** A drain hook with a handle on its listener, and nothing else. */
function fakeIngest(): {
  ingest: Ingest;
  drain(threadId: string, ingested: number): void;
} {
  const listeners: Array<(threadId: string, ingested: number) => void> = [];
  return {
    ingest: {
      onDrained(listener: (threadId: string, ingested: number) => void) {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
    } as unknown as Ingest,
    drain(threadId, ingested) {
      for (const listener of listeners) listener(threadId, ingested);
    },
  };
}

describe("the watch drain listener", () => {
  it("evaluates nothing while the module toggle is off", async () => {
    const harness = makeHarness({ "modules_watch_enabled": false });
    const drainHook = fakeIngest();
    const handle: WatchHandle = { current: null };

    await harness.registry.register([
      createWatchModule({
        handle,
        ingest: () => drainHook.ingest,
        settings: harness.settings,
      }),
    ]);

    // A thread that would stall the moment anyone looked at it.
    const threadId = "thr-toggled-off";
    harness.store.upsertThread({
      thread_id: threadId,
      title: "[obs-test] silent",
      status: "active",
      root_thread_id: threadId,
      depth: 0,
    });
    harness.store.upsertTurn({
      thread_id: threadId,
      turn_id: "turn-1",
      root_thread_id: threadId,
      seq_started: 1,
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
      completed_at: new Date(Date.now() - 3_600_000).toISOString(),
    });

    drainHook.drain(threadId, 3);

    expect(handle.current!.queries.openSignals(threadId)).toEqual([]);
    expect(harness.harness.inspection.realtimeSignals).toEqual([]);
  });

  it("evaluates on a drain while the module toggle is on", async () => {
    const harness = makeHarness({ "modules_watch_enabled": true });
    const drainHook = fakeIngest();
    const handle: WatchHandle = { current: null };

    await harness.registry.register([
      createWatchModule({
        handle,
        ingest: () => drainHook.ingest,
        settings: harness.settings,
      }),
    ]);

    const threadId = "thr-toggled-on";
    harness.store.upsertThread({
      thread_id: threadId,
      title: "[obs-test] silent",
      status: "active",
      root_thread_id: threadId,
      depth: 0,
    });
    harness.store.upsertTurn({
      thread_id: threadId,
      turn_id: "turn-1",
      root_thread_id: threadId,
      seq_started: 1,
      started_at: new Date(Date.now() - 3_600_000).toISOString(),
      completed_at: new Date(Date.now() - 3_600_000).toISOString(),
    });

    drainHook.drain(threadId, 3);

    expect(
      handle.current!.queries.openSignals(threadId).length,
    ).toBeGreaterThan(0);
  });
});
