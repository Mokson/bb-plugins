// `obs_log_turn.ts` was declared TEXT, so SQLite's TEXT affinity stored every
// bound integer as a string and every range query compared strings.
//
// That worked only because epoch milliseconds happen to be 13 digits wide
// today: equal-length digit strings sort the same either way. The first value
// of a different width breaks it silently. A second-resolution stamp, or a
// provider that wrote a small default, sorts BELOW every 13-digit value as a
// string and above it as a number, so it drops out of, or falls into, windows
// it does not belong in. No error, just a wrong total.
import { afterEach, describe, expect, it } from "vitest";
import { LogStore, type LogTurnRow } from "../src/core/store-logs.js";
import { TempDatabase } from "./fakes.js";

let temp: TempDatabase | null = null;
afterEach(() => {
  temp?.dispose();
  temp = null;
});

function turn(logKey: string, ts: number): LogTurnRow {
  return {
    log_key: logKey,
    provider: "codex",
    provider_thread_id: "s-1",
    path: "/logs/s-1.jsonl",
    ts,
    model: "gpt-5.6-sol",
    input: 1,
    cache_read: 2,
    cache_write: null,
    output: 3,
    reasoning: 0,
    logged_cost_usd: null,
    is_sidechain: 0,
    agent_id: null,
    cwd: null,
    skill_names: null,
    mcp_names: null,
  };
}

describe("a timestamp range over values of different digit widths", () => {
  it("orders and filters numerically", () => {
    temp = new TempDatabase();
    const store = new LogStore(temp.openDatabase());
    // 10, 12 and 13 digits. As strings, "999..." sorts after "1788..." and
    // "500000" sorts before both, so a lexicographic comparison gets both the
    // ordering and the window wrong.
    store.upsertLogTurn(turn("small", 500_000));
    store.upsertLogTurn(turn("twelve", 999_999_999_999));
    store.upsertLogTurn(turn("thirteen", 1_788_000_000_000));

    const query = {
      provider: "codex",
      providerThreadId: "s-1",
      tsFrom: 0,
      tsTo: Number.MAX_SAFE_INTEGER,
    };
    expect(store.listLogTurns(query).map((row) => row.log_key)).toEqual([
      "small",
      "twelve",
      "thirteen",
    ]);
    // A window that excludes only the smallest value.
    expect(
      store
        .listLogTurns({ ...query, tsFrom: 600_000 })
        .map((row) => row.log_key),
    ).toEqual(["twelve", "thirteen"]);
    // ...and one that holds only the 12-digit value in the middle.
    expect(
      store
        .listLogTurns({ ...query, tsFrom: 600_000, tsTo: 1_000_000_000_000 })
        .map((row) => row.log_key),
    ).toEqual(["twelve"]);
    // Read back as a number, not the string the TEXT column handed over.
    expect(store.listLogTurns(query)[0]!.ts).toBe(500_000);
  });
});
