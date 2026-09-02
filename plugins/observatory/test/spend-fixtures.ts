// Ledger seeding for the spend tests.
//
// Every spend surface is pure SQL over `obs_thread` and `obs_turn`, so the
// tests seed those two tables directly through the real store rather than
// driving ingest: the rollup rules are what is under test, not the drain.
import type { PricingCatalog } from "../src/core/catalog.js";
import type { ObservatoryStore, ThreadRow, TurnRow } from "../src/core/store.js";

export interface SeedThread extends Partial<ThreadRow> {
  thread_id: string;
}

export interface SeedTurn extends Partial<TurnRow> {
  thread_id: string;
  turn_id: string;
}

export function seedThread(store: ObservatoryStore, thread: SeedThread): void {
  store.upsertThread({
    root_thread_id: thread.thread_id,
    depth: 0,
    provider_id: "claude-code",
    status: "idle",
    ...thread,
  });
}

export function seedTurn(store: ObservatoryStore, turn: SeedTurn): void {
  store.upsertTurn({
    started_at: "2026-08-30T10:00:00.000Z",
    input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    cache_read_tokens: null,
    cache_write_tokens: null,
    cost_usd: null,
    cost_source: "catalog",
    split_source: "log-exact",
    ...turn,
  });
}

/** A log row plus its match, which is how skill and MCP names reach a turn. */
export function seedLogTurn(
  store: ObservatoryStore,
  row: {
    threadId: string;
    turnId: string;
    logKey: string;
    skillNames?: string[];
    mcpNames?: string[];
  },
): void {
  store.db
    .prepare(
      `INSERT INTO obs_log_turn (log_key, provider, skill_names, mcp_names)
       VALUES (?, 'claude-code', ?, ?)`,
    )
    .run(
      row.logKey,
      row.skillNames ? JSON.stringify(row.skillNames) : null,
      row.mcpNames ? JSON.stringify(row.mcpNames) : null,
    );
  store.db
    .prepare(
      `INSERT INTO obs_match (thread_id, turn_id, log_key, method, confidence)
       VALUES (?, ?, ?, 'log-exact', 1)`,
    )
    .run(row.threadId, row.turnId, row.logKey);
}

/**
 * A catalog with one priced model, so pricing tests need no network. The
 * provider key is `anthropic` because `normalizeProviderId` aliases the
 * `claude-code` provider id onto it.
 */
export function testCatalog(): PricingCatalog {
  return {
    revision: "test",
    providers: {
      anthropic: {
        "test-model": { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
      },
    },
  };
}
