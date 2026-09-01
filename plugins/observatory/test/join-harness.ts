// Shared scaffolding for the join tests.
//
// Every join invariant needs the same three things: a migrated database with
// one thread, a handful of bb turns, and a fake log whose rows the test
// controls to the millisecond. Kept here rather than re-declared per file
// because eight tests share the shapes and eight copies drift apart.
import { EventStore } from "../src/core/store-events.js";
import type { LogTurn, PriceTurnResult } from "../src/core/join.js";
import { ObservatoryStore, type SplitSource } from "../src/core/store.js";
import { TempDatabase } from "./fakes.js";

export const SESSION = "sess-1";
export const PROVIDER = "claude-code";

/** A flat price so a cost assertion reads as a token assertion. */
export const flatPrice: PriceTurnResult = {
  costUsd: 1,
  costSource: "catalog",
  pricingStatus: "exact",
  cacheSavingsUsd: 0,
};

export interface RowSpec {
  key: string;
  at: string;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  input?: number;
  reasoning?: number;
  model?: string | null;
  loggedCostUsd?: number | null;
  sidechain?: boolean;
  agentId?: string | null;
  /** Log-side provider id, which is not always bb's id for the same provider. */
  provider?: string;
}

export function row(spec: RowSpec): LogTurn {
  const provider = spec.provider ?? PROVIDER;
  return {
    log_key: `${provider}:${SESSION}:${spec.key}`,
    provider,
    provider_thread_id: SESSION,
    ts: Date.parse(spec.at),
    model: spec.model === undefined ? "claude-opus-5" : spec.model,
    input: spec.input ?? 10,
    cache_read: spec.cacheRead ?? 100,
    cache_write: spec.cacheWrite ?? 10,
    output: spec.output ?? 5,
    reasoning: spec.reasoning ?? 0,
    logged_cost_usd: spec.loggedCostUsd ?? null,
    is_sidechain: spec.sidechain ? 1 : 0,
    agent_id: spec.agentId ?? null,
    skill_names: null,
    mcp_names: null,
  };
}

export interface TurnSpec {
  id: string;
  started: string;
  completed: string;
  cached?: number | null;
  output?: number | null;
  input?: number | null;
  /** Anything but `unavailable` keeps the turn out of the pending queue. */
  split?: SplitSource;
}

export class JoinHarness {
  readonly temp = new TempDatabase();
  readonly store: ObservatoryStore;
  readonly events: EventStore;
  readonly provider: string;

  constructor(turns: readonly TurnSpec[], providerId: string = PROVIDER) {
    this.provider = providerId;
    this.store = this.temp.open();
    this.events = new EventStore(this.store.db);
    this.store.upsertThread({
      thread_id: "thr-1",
      provider_id: providerId,
      provider_thread_id: SESSION,
    });
    for (const turn of turns) {
      this.store.upsertTurn({
        thread_id: "thr-1",
        turn_id: turn.id,
        started_at: turn.started,
        completed_at: turn.completed,
        input_tokens: turn.input ?? 0,
        cached_input_tokens: turn.cached ?? 0,
        output_tokens: turn.output ?? 0,
        split_source: turn.split ?? "unavailable",
      });
    }
  }

  deps(rows: readonly LogTurn[], priceTurn = () => flatPrice) {
    return {
      store: this.store,
      events: this.events,
      logs: {
        listLogTurns: (query: { provider: string }) =>
          rows.filter((row) => row.provider === query.provider),
      },
      priceTurn,
      catalog: null,
    };
  }

  turnRow(turnId: string): Record<string, unknown> {
    return this.store.db
      .prepare("SELECT * FROM obs_turn WHERE turn_id = ?")
      .get(turnId) as Record<string, unknown>;
  }

  matchRows(): Record<string, unknown>[] {
    return this.store.db
      .prepare("SELECT * FROM obs_match ORDER BY turn_id")
      .all() as Record<string, unknown>[];
  }

  stats(): {
    turns: Record<string, { rows: number; models: string[]; tokenSource: string }>;
    unattributedBefore: number;
    unattributedAfter: number;
  } {
    const raw = this.store.getMeta(`join:${this.provider}:${SESSION}`);
    if (!raw) throw new Error("no join stats recorded");
    return JSON.parse(raw);
  }

  dispose(): void {
    this.temp.dispose();
  }
}
