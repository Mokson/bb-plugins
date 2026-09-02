// TECH invariant 1: a steer never stops a thread.
//
// Two proofs, because either alone is weak. The behavioural one runs a full
// evaluation in steer mode against an SDK whose stop, cancel and interrupt
// throw on contact. The structural one greps the watch source, which also
// catches a call added down a branch no fixture happens to reach.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeWatchFixture, T0, type WatchFixture } from "./fakes.js";

let fixture: WatchFixture;

afterEach(() => fixture?.dispose());

const WATCH_SRC = fileURLToPath(new URL("../src/watch", import.meta.url));

describe("the steer ladder", () => {
  it("touches no stop, cancel or interrupt while steering", async () => {
    const clock = { now: T0 };
    fixture = makeWatchFixture({ "watch_mode": "steer" }, clock);
    await fixture.host.bb.storage.kv.set("watch:mode", "steer");
    await fixture.runtime.refresh();
    expect(fixture.runtime.config().mode).toBe("steer");

    const sent: unknown[] = [];
    const forbidden = () => {
      throw new Error("watch must never terminate agent work");
    };
    Object.defineProperty(fixture.host.bb, "sdk", {
      configurable: true,
      get: () => ({
        threads: {
          send: (args: unknown) => {
            sent.push(args);
            return Promise.resolve({ ok: true, delivery: "sent" });
          },
          stop: forbidden,
          cancel: forbidden,
          interrupt: forbidden,
        },
      }),
    });

    // A silence stall: steer-eligible, so this really does reach `send`.
    const thread = fixture.seedThread({ threadId: "thr-silent" });
    fixture.seedTurns(thread, [
      {
        turnId: "turn-1",
        seqStarted: 1,
        startedAt: -900_000,
        completedAt: -900_000,
      },
    ]);
    fixture.seedItems(thread, [
      { seq: 2, kind: "toolCall", startedAt: -600_000, completedAt: -600_000 },
    ]);

    // Silence and active-no-turn both hold on this fixture; the count is not
    // the point, reaching `send` without reaching `stop` is.
    expect(
      fixture.runtime.engine.evaluateThread(thread)!.opened,
    ).toBeGreaterThan(0);
    await fixture.runtime.ladder.settled();

    // The proof is positive as well as negative: it DID send, so the absence
    // of a stop is not just the absence of any call at all.
    expect(sent.length).toBeGreaterThan(0);
  });

  it("carries no stop, cancel or interrupt call site anywhere in src/watch", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(WATCH_SRC)) {
      if (!name.endsWith(".ts")) continue;
      const source = readFileSync(join(WATCH_SRC, name), "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        // Comments explain the ban; code must not perform it.
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (/threads\s*\.\s*(stop|cancel|interrupt|archive|delete)\s*\(/.test(line)) {
          offenders.push(`${name}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("reaches threads.send from exactly one place", () => {
    // One call site is what makes "record before send" checkable at all. A
    // second one would be a path the ordering test does not cover.
    const sites: string[] = [];
    for (const name of readdirSync(WATCH_SRC)) {
      if (!name.endsWith(".ts")) continue;
      const source = readFileSync(join(WATCH_SRC, name), "utf8");
      for (const [index, line] of source.split("\n").entries()) {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        if (/threads\s*\.\s*send\s*\(/.test(line)) {
          sites.push(`${name}:${index + 1}`);
        }
      }
    }
    expect(sites).toHaveLength(1);
    expect(sites[0]).toMatch(/^module\.ts:/);
  });
});
