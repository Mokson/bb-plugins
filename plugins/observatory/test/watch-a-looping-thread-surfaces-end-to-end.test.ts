// The motivating scenario, end to end: a thread runs the same command eight
// times, and a person asks `bb observatory watch` what is going on.
//
// This is the one test that runs the WHOLE path — real bb events through the
// real ingest, ingest's drain hook into the watch engine, the engine's signal
// into the CLI renderer and the inbox — rather than any single unit of it. The
// units are covered elsewhere; what this catches is the wiring between them,
// which is exactly what no unit test can see.
import { afterEach, describe, expect, it } from "vitest";
import { createIngest } from "../src/core/ingest.js";
import { EventStore } from "../src/core/store-events.js";
import { ObservatoryStore } from "../src/core/store.js";
import { createWatchRuntime } from "../src/watch/module.js";
import { runWatchCli } from "../src/watch/cli.js";
import { buildInbox } from "../src/watch/views.js";
import { createWatchRpcHandlers } from "../src/watch/rpc.js";
import { MIGRATIONS } from "../src/core/store.js";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { event, makeIngestHost } from "./fakes.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

const THREAD = "thr-1";
const T0 = Date.parse("2026-09-01T12:00:00.000Z");

let close: (() => void) | null = null;
afterEach(() => {
  close?.();
  close = null;
});

/** `ls` eight times: one item/started + item/completed pair per call, all
 * carrying the same fingerprint because the command never changes. */
function loopEvents() {
  const rows = [
    event(1, "turn/started", {}, { turnId: "turn-1" }),
  ];
  let seq = 2;
  for (let call = 0; call < 8; call += 1) {
    const item = {
      id: `item-${call}`,
      type: "commandExecution",
      command: "ls",
      status: "completed",
    };
    rows.push(
      event(seq++, "item/started", { item }, { turnId: "turn-1" }),
      event(seq++, "item/completed", { item }, { turnId: "turn-1" }),
    );
  }
  return rows;
}

describe("a thread that runs the same command eight times", () => {
  it("shows up as a repeated-identical-tool stall in the CLI and the inbox", async () => {
    // One database, two readers: core writes the ledger, watch reads it.
    const host = createFakePluginHost({ pluginId: "observatory" });
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, MIGRATIONS);
    close = () => db.close();

    const store = new ObservatoryStore(db);
    const events = new EventStore(db);
    const ingestHost = makeIngestHost();
    ingestHost.threads.set(THREAD, { id: THREAD, status: "active" });
    ingestHost.pages.set(THREAD, loopEvents());

    const ingest = createIngest({
      bb: ingestHost.bb,
      store,
      events,
      logs: null,
      priceTurn: null,
    });

    const clock = { now: T0 };
    const settingValues: Record<string, string | boolean | undefined> = {
      // Keep the assertion about the loop, not about the synthetic clock
      // drifting the thread into silence as well.
      "watch_silenceNoInflight_enabled": false,
      "watch_activeNoTurn_enabled": false,
    };
    const runtime = createWatchRuntime({
      bb: host.bb,
      db,
      settings: async () => settingValues,
      now: () => clock.now,
    });
    await runtime.refresh();

    // The wiring under test: watch evaluates off core's drain, with no second
    // subscription of its own.
    let evaluated = 0;
    ingest.onDrained((threadId, count) => {
      if (count === 0) return;
      evaluated += 1;
      runtime.engine.evaluateThread(threadId);
    });

    const ingested = await ingest.drainThread(THREAD);
    expect(ingested).toBeGreaterThan(0);
    expect(evaluated).toBe(1);

    // The signal exists, attributed to the right rule and thread.
    const open = runtime.queries.openSignals(THREAD);
    expect(open.map((row) => row.kind)).toEqual(["repeated-identical-tool"]);

    // `bb observatory watch --json` reports it.
    const result = await runWatchCli(
      host.bb,
      { current: runtime },
      ["--json"],
      () => clock.now,
    );
    expect(result.exitCode).toBe(0);
    const view = JSON.parse(result.stdout!) as {
      watched: number;
      rows: Array<Record<string, unknown>>;
    };
    expect(view.watched).toBe(1);
    expect(view.rows[0]).toMatchObject({
      threadId: THREAD,
      state: "stalled",
      rule: "repeated-identical-tool",
    });
    expect(String(view.rows[0]!.diagnostic)).toMatch(/repeat/);

    // The human rendering names the rule too.
    const text = await runWatchCli(
      host.bb,
      { current: runtime },
      [],
      () => clock.now,
    );
    expect(text.stdout).toContain("STALL");
    expect(text.stdout).toContain("repeated-identical-tool");

    // `watch explain` carries the signal and the observe action behind it.
    const explain = await runWatchCli(
      host.bb,
      { current: runtime },
      ["explain", THREAD],
      () => clock.now,
    );
    expect(explain.exitCode).toBe(0);
    expect(explain.stdout).toContain("repeated-identical-tool");
    expect(explain.stdout).toContain("observe");

    // And it is the top row of the inbox.
    const inbox = buildInbox(runtime.queries, 50);
    expect(inbox.rows[0]).toMatchObject({
      source: "watch",
      kind: "repeated-identical-tool",
      threadId: THREAD,
    });
    expect(inbox.counts.stalled).toBe(1);

    // The RPC the panel calls returns the same rows the CLI just rendered.
    const handlers = createWatchRpcHandlers(
      host.bb,
      { current: runtime },
      () => clock.now,
    );
    const rpcView = await handlers["observatory_watch_list"]({});
    expect(rpcView).toEqual(view);

    const signals = await handlers["observatory_watch_signals"]({
      threadId: THREAD,
      open: true,
    });
    expect(signals.rows).toHaveLength(1);
    expect(signals.rows[0]).toMatchObject({
      kind: "repeated-identical-tool",
      threadId: THREAD,
      closedAt: null,
    });
  });

  it("stops reporting the loop once the thread does something else", async () => {
    const host = createFakePluginHost({ pluginId: "observatory" });
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, MIGRATIONS);
    close = () => db.close();

    const store = new ObservatoryStore(db);
    const events = new EventStore(db);
    const ingestHost = makeIngestHost();
    ingestHost.threads.set(THREAD, { id: THREAD, status: "active" });
    ingestHost.pages.set(THREAD, loopEvents());

    const ingest = createIngest({
      bb: ingestHost.bb,
      store,
      events,
      logs: null,
      priceTurn: null,
    });
    const clock = { now: T0 };
    const runtime = createWatchRuntime({
      bb: host.bb,
      db,
      settings: async () => ({
        "watch_silenceNoInflight_enabled": false,
        "watch_activeNoTurn_enabled": false,
      }),
      now: () => clock.now,
    });
    await runtime.refresh();
    ingest.onDrained((threadId, count) => {
      if (count > 0) runtime.engine.evaluateThread(threadId);
    });
    await ingest.drainThread(THREAD);
    expect(runtime.queries.openSignals(THREAD)).toHaveLength(1);

    // Twenty distinct commands push the loop's anchor out of the window.
    const more = [];
    let seq = 100;
    for (let call = 0; call < 20; call += 1) {
      const item = {
        id: `later-${call}`,
        type: "commandExecution",
        command: `echo ${call}`,
        status: "completed",
      };
      more.push(
        event(seq++, "item/started", { item }, { turnId: "turn-1" }),
        event(seq++, "item/completed", { item }, { turnId: "turn-1" }),
      );
    }
    ingestHost.pages.set(THREAD, [
      ...(ingestHost.pages.get(THREAD) ?? []),
      ...more,
    ]);
    clock.now = T0 + 60_000;
    await ingest.drainThread(THREAD);

    expect(runtime.queries.openSignals(THREAD)).toHaveLength(0);
    const all = runtime.queries.signalsForThread(THREAD);
    expect(all).toHaveLength(1);
    expect(all[0]!.closed_at).not.toBeNull();
  });
});

/** The fake ingest host's `bb` is a structural stub; this keeps the cast in
 * one place so a widened SDK surface fails here rather than mid-test. */
export type _IngestBb = BbPluginApi;
