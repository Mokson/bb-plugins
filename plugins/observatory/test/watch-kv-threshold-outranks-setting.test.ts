// A threshold lives in two places and the answer must never be ambiguous.
// The setting is the durable default and needs a plugin reload; the kv
// override is what the panel writes while someone is staring at a false
// positive. Reload-to-apply is exactly the wrong latency for that, so kv wins
// — and `source` says which layer answered, because "I changed it and nothing
// happened" is otherwise indistinguishable from a bug.
import { afterEach, describe, expect, it } from "vitest";
import { MODE_KV_KEY, THRESHOLDS_KV_KEY } from "../src/watch/settings.js";
import { createWatchRpcHandlers } from "../src/watch/rpc.js";
import { makeWatchFixture, T0, type WatchFixture } from "./fakes.js";

let fixture: WatchFixture;

afterEach(() => fixture?.dispose());

describe("a watch threshold", () => {
  it("takes the kv override over the setting and names the layer", async () => {
    fixture = makeWatchFixture({ "watch_silenceMinutes": "9" });
    await fixture.runtime.refresh();
    expect(fixture.runtime.config().thresholds["watch_silenceMinutes"]).toBe(9);
    expect(fixture.runtime.config().source["watch_silenceMinutes"]).toBe(
      "setting",
    );

    await fixture.host.bb.storage.kv.set(THRESHOLDS_KV_KEY, {
      "watch_silenceMinutes": 2,
    });
    await fixture.runtime.refresh();

    expect(fixture.runtime.config().thresholds["watch_silenceMinutes"]).toBe(2);
    expect(fixture.runtime.config().source["watch_silenceMinutes"]).toBe("kv");
    // A key the override does not mention still answers from the setting.
    expect(fixture.runtime.config().source["watch_repeatCount"]).toBe(
      "setting",
    );
  });

  it("changes what the rules actually fire on", async () => {
    const clock = { now: T0 };
    fixture = makeWatchFixture(
      { "watch_repeatCount": "5", "watch_activeNoTurn_enabled": false },
      clock,
    );
    await fixture.runtime.refresh();
    const thread = fixture.seedThread({ threadId: "thr-loop" });
    fixture.seedTurns(thread, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -60_000 },
    ]);
    // Three repeats: under the setting's 5, over an override of 3.
    fixture.seedItems(
      thread,
      [2, 3, 4].map((seq) => ({
        seq,
        kind: "toolCall",
        fingerprint: "fp-ls",
        startedAt: -50_000 + seq * 1_000,
        completedAt: -49_000 + seq * 1_000,
      })),
    );

    fixture.runtime.engine.evaluateThread(thread);
    expect(
      fixture.runtime.queries
        .openSignals(thread)
        .filter((row) => row.kind === "repeated-identical-tool"),
    ).toHaveLength(0);

    await fixture.host.bb.storage.kv.set(THRESHOLDS_KV_KEY, {
      "watch_repeatCount": 3,
    });
    await fixture.runtime.refresh();
    fixture.runtime.engine.evaluateThread(thread);

    expect(
      fixture.runtime.queries
        .openSignals(thread)
        .filter((row) => row.kind === "repeated-identical-tool"),
    ).toHaveLength(1);
  });

  it("takes the kv mode over the watch_mode setting", async () => {
    fixture = makeWatchFixture({ "watch_mode": "observe" });
    await fixture.runtime.refresh();
    expect(fixture.runtime.config().mode).toBe("observe");
    expect(fixture.runtime.config().source["mode"]).toBe("setting");

    await fixture.host.bb.storage.kv.set(MODE_KV_KEY, "off");
    await fixture.runtime.refresh();
    expect(fixture.runtime.config().mode).toBe("off");
    expect(fixture.runtime.config().source["mode"]).toBe("kv");
  });

  it("merges a settings_set write instead of replacing the whole override", async () => {
    fixture = makeWatchFixture();
    await fixture.runtime.refresh();
    const handlers = createWatchRpcHandlers(fixture.host.bb, {
      current: fixture.runtime,
    });

    await handlers["observatory_watch_settings_set"]({
      thresholds: { "watch_silenceMinutes": 2 },
    });
    const after = await handlers["observatory_watch_settings_set"]({
      thresholds: { "watch_repeatCount": 7 },
      mode: "steer",
    });

    // The first override survived the second write.
    expect(after.thresholds["watch_silenceMinutes"]).toBe(2);
    expect(after.thresholds["watch_repeatCount"]).toBe(7);
    expect(after.source["watch_silenceMinutes"]).toBe("kv");
    expect(after.mode).toBe("steer");
    expect(after.note).not.toBeNull();
  });

  it("drops only the reset keys, so those rows follow the setting again", async () => {
    fixture = makeWatchFixture({
      "watch_silenceMinutes": "9",
      "watch_repeatCount": "5",
    });
    await fixture.runtime.refresh();
    const handlers = createWatchRpcHandlers(fixture.host.bb, {
      current: fixture.runtime,
    });

    const overridden = await handlers["observatory_watch_settings_set"]({
      thresholds: { "watch_silenceMinutes": 2, "watch_repeatCount": 3 },
    });
    expect(overridden.source["watch_silenceMinutes"]).toBe("kv");
    expect(overridden.source["watch_repeatCount"]).toBe("kv");

    const after = await handlers["observatory_watch_settings_set"]({
      reset: ["watch_silenceMinutes"],
    });

    // The reset row falls back to the setting's 9, not to the 2 it held.
    expect(after.thresholds["watch_silenceMinutes"]).toBe(9);
    expect(after.source["watch_silenceMinutes"]).toBe("setting");
    // Its neighbour's override is untouched.
    expect(after.thresholds["watch_repeatCount"]).toBe(3);
    expect(after.source["watch_repeatCount"]).toBe("kv");
  });
});
