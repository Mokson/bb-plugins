// The phase-2 promise: watch OBSERVES. Phase 3's steer ladder is gated on
// precision data measured from this phase, so a build that steers early both
// breaks that promise and poisons the data that would justify it.
//
// Two proofs, because either alone is weak. The behavioural one runs a full
// evaluation against an SDK whose `threads.send`/`threads.stop` throw on
// contact. The structural one greps the watch source, which also catches a
// call added down a branch no fixture happens to reach.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeWatchFixture, T0, type WatchFixture } from "./fakes.js";

let fixture: WatchFixture;

afterEach(() => fixture?.dispose());

const WATCH_SRC = fileURLToPath(new URL("../src/watch", import.meta.url));

describe("the phase 2 ladder", () => {
  it("never reaches threads.send or threads.stop, even in steer mode", async () => {
    const clock = { now: T0 };
    // steer is ACCEPTED and stored in this phase; it must still not send.
    fixture = makeWatchFixture({ "watch_mode": "steer" }, clock);
    await fixture.host.bb.storage.kv.set("watch:mode", "steer");
    await fixture.runtime.refresh();
    expect(fixture.runtime.config().mode).toBe("steer");

    // Any touch of the send/stop surface is a test failure, not a mock return.
    const forbidden = () => {
      throw new Error("phase 2 must not touch a running thread");
    };
    Object.defineProperty(fixture.host.bb, "sdk", {
      configurable: true,
      get: () => ({
        threads: {
          send: forbidden,
          stop: forbidden,
          cancel: forbidden,
          interrupt: forbidden,
        },
      }),
    });

    const thread = fixture.seedThread({ threadId: "thr-loop" });
    fixture.seedTurns(thread, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -60_000 },
    ]);
    fixture.seedItems(
      thread,
      [2, 3, 4].map((seq) => ({
        seq,
        kind: "toolCall",
        name: "Bash",
        fingerprint: "fp-ls",
        startedAt: -50_000 + seq * 1_000,
        completedAt: -49_000 + seq * 1_000,
      })),
    );

    const result = fixture.runtime.engine.evaluateThread(thread)!;
    expect(result.opened).toBeGreaterThan(0);

    // What it did instead: recorded, and only ever as "observe".
    const actions = fixture.runtime.queries.actionsForThread(thread, 100);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((action) => action.action === "observe")).toBe(true);
  });

  it("carries no send or stop call site anywhere in src/watch", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(WATCH_SRC)) {
      if (!name.endsWith(".ts")) continue;
      const source = readFileSync(join(WATCH_SRC, name), "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        // Comments explain the ban; code must not perform it.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (
          /threads\s*\.\s*(send|stop|cancel|interrupt)\s*\(/.test(line) ||
          /\bsendMessage\s*\(/.test(line)
        ) {
          offenders.push(`${name}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reports steer back to the caller with a note that it observes only", async () => {
    fixture = makeWatchFixture({ "watch_mode": "steer" });
    await fixture.runtime.refresh();
    const { settingsView } = await import("../src/watch/rpc.js");
    const view = settingsView(fixture.runtime);
    expect(view.mode).toBe("steer");
    expect(view.note).toContain("observes only");
  });

  it("records nothing at all in off mode", async () => {
    fixture = makeWatchFixture({ "watch_mode": "off" });
    await fixture.runtime.refresh();
    const thread = fixture.seedThread({ threadId: "thr-off" });
    fixture.seedTurns(thread, [
      { turnId: "turn-1", seqStarted: 1, startedAt: -60_000 },
    ]);
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

    expect(fixture.runtime.engine.evaluateThread(thread)).toBeNull();
    expect(fixture.runtime.queries.signalsForThread(thread)).toEqual([]);
  });
});
