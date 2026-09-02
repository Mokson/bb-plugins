// `bb observatory watch steer <threadId>` and its escalate twin.
//
// `watch steer` with no argument still sets the mode, and `watch steer <id>`
// steers that thread. The two spellings collide on purpose — a person types
// the word they mean — so the ARGUMENT decides, and this pins that split.
// Both reach the same `runManualSteer` the panel button does, so the CLI and
// the page cannot record differently.
import { afterEach, describe, expect, it } from "vitest";
import { runWatchCli } from "../src/watch/cli.js";
import type { WatchHandle } from "../src/watch/module.js";
import { makeWatchFixture, T0, type WatchFixture } from "./fakes.js";

let fixture: WatchFixture;
const clock = { now: T0 };

afterEach(() => fixture?.dispose());

interface Sent {
  threadId: string;
  mode: string;
}

/** Records every send and returns the list. */
function captureSends(fixture: WatchFixture): Sent[] {
  const sent: Sent[] = [];
  Object.defineProperty(fixture.host.bb, "sdk", {
    configurable: true,
    get: () => ({
      threads: {
        send: (args: Sent) => {
          sent.push(args);
          return Promise.resolve({ ok: true, delivery: "sent" });
        },
      },
    }),
  });
  return sent;
}

function handle(fixture: WatchFixture): WatchHandle {
  return { current: fixture.runtime };
}

describe("bb observatory watch steer", () => {
  it("steers the named thread and prints one confirmation line", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({ "watch_mode": "steer" }, clock);
    await fixture.runtime.refresh();
    const sent = captureSends(fixture);
    const thread = fixture.seedThread({ threadId: "thr-live" });

    const result = await runWatchCli(
      fixture.host.bb,
      handle(fixture),
      ["steer", thread, "--note", "check in please"],
      () => clock.now,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`steered ${thread}\n`);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.threadId).toBe(thread);

    // Recorded, as the panel's click would be.
    const actions = fixture.runtime.queries.actionsForThread(thread, 10);
    expect(actions[0]?.action).toBe("steer");
    expect(actions[0]?.detail).toContain("by cli");
  });

  it("escalates to the parent and names it in the confirmation", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({ "watch_mode": "steer" }, clock);
    await fixture.runtime.refresh();
    const sent = captureSends(fixture);
    fixture.seedThread({ threadId: "thr-parent" });
    const child = fixture.seedThread({
      threadId: "thr-child",
      rootThreadId: "thr-parent",
    });
    fixture.store.upsertThread({
      thread_id: child,
      parent_thread_id: "thr-parent",
      root_thread_id: "thr-parent",
    });

    const result = await runWatchCli(
      fixture.host.bb,
      handle(fixture),
      ["escalate", child],
      () => clock.now,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("thr-parent");
    expect(sent[0]?.threadId).toBe("thr-parent");
  });

  it("still sets the mode when no thread is named", async () => {
    clock.now = T0;
    fixture = makeWatchFixture({ "watch_mode": "observe" }, clock);
    await fixture.runtime.refresh();

    const result = await runWatchCli(
      fixture.host.bb,
      handle(fixture),
      ["steer"],
      () => clock.now,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("watch mode steer");
    expect(fixture.runtime.config().mode).toBe("steer");
  });

  it("exits non-zero on a refusal, on stderr", async () => {
    // A script piping this into a loop must not read "watch mode is observe"
    // as a steer that happened.
    clock.now = T0;
    fixture = makeWatchFixture({ "watch_mode": "observe" }, clock);
    await fixture.runtime.refresh();
    const sent = captureSends(fixture);
    const thread = fixture.seedThread({ threadId: "thr-live" });

    const result = await runWatchCli(
      fixture.host.bb,
      handle(fixture),
      ["steer", thread],
      () => clock.now,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("set it to steer first");
    expect(result.stdout).toBeUndefined();
    expect(sent).toEqual([]);
  });
});
