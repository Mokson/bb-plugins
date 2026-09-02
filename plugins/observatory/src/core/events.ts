// Event normalization: one page of `ThreadEventRow`s in, ledger rows out.
//
// Pure. No database, no clock, no SDK. Everything the normalizer needs to
// continue across pages travels in an explicit carry, which is what makes a
// replay of the same page from the same watermark produce the same rows: the
// ingest loop re-derives, it never accumulates behind the store's back.
//
// Two rules this file exists to keep:
//  - message text and tool arguments are NEVER copied into a row. Items carry
//    a fingerprint of normalized arguments, so "the same command six times" is
//    detectable without the plugin holding a transcript.
//  - a running total is not a per-turn number. `thread/tokenUsage/updated`
//    reports thread totals that RESET when the provider compacts, so the delta
//    is guarded: a total that went backwards is a new baseline, never a
//    negative turn.
import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ItemRow, ThreadRow, TurnRow } from "./store.js";

/**
 * The SDK does not re-export `ThreadEventRow` from `@bb/domain`, so the row
 * type is read back off the call that produces it. That keeps this file
 * pinned to the installed SDK rather than to a private package.
 */
export type ThreadsApi = BbPluginApi["sdk"]["threads"];
export type ThreadEventRow = Awaited<
  ReturnType<ThreadsApi["events"]["list"]>
>[number];

/** Args keys that change every call and would break a fingerprint. */
const VOLATILE_ARG_KEYS = new Set([
  "cwd",
  "id",
  "nonce",
  "requestid",
  "sessionid",
  "threadid",
  "timestamp",
  "token",
  "ts",
  "uuid",
  "_meta",
]);

/** How many turns of per-turn accumulators the carry keeps. */
export const CARRY_TURN_LIMIT = 64;

export interface TokenTotals {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

export interface TurnCounters {
  tool_calls: number;
  file_changes: number;
  file_reads: number;
}

export interface NormalizeCarry {
  /** The turn open at the page boundary; thread-scoped usage attaches here. */
  openTurnId: string | null;
  /**
   * The turn that most recently completed, until the next one starts.
   *
   * Providers flush the usage total AFTER they close the turn, so a
   * `thread/tokenUsage/updated` routinely arrives with no turn open. Dropping
   * it would still advance the running baseline, which silently donates that
   * turn's tokens to whichever turn opens next.
   */
  lastCompletedTurnId: string | null;
  /** Last seen thread running totals, or null before the first usage event. */
  totals: TokenTotals | null;
  /** Newest `client/turn/requested` execution, applied to turns after it. */
  modelRequested: string | null;
  effort: string | null;
  /** Absolute per-turn accumulators, so a page carries no partial rows. */
  usageByTurn: Record<string, TokenTotals>;
  countersByTurn: Record<string, TurnCounters>;
}

export type TurnPatch = Partial<TurnRow> & {
  thread_id: string;
  turn_id: string;
};
export type ItemPatch = Partial<ItemRow> & {
  item_id: string;
  thread_id: string;
};
export type ThreadPatch = Partial<ThreadRow> & { thread_id: string };

export interface NormalizeResult {
  thread: ThreadPatch;
  turns: TurnPatch[];
  items: ItemPatch[];
  carry: NormalizeCarry;
  /** The highest `seq` in the page, or null for an empty page. */
  lastSeq: number | null;
}

export function emptyCarry(): NormalizeCarry {
  return {
    openTurnId: null,
    lastCompletedTurnId: null,
    totals: null,
    modelRequested: null,
    effort: null,
    usageByTurn: {},
    countersByTurn: {},
  };
}

/**
 * A turn's share of a running total. A component that went DOWN means the
 * provider reset its counters (compaction, context clear, a fresh session), so
 * the current total is the delta rather than a negative number.
 */
export function delta(
  current: TokenTotals,
  previous: TokenTotals | null,
): TokenTotals {
  if (!previous) return { ...current };
  const reset =
    current.input < previous.input ||
    current.cached < previous.cached ||
    current.output < previous.output ||
    current.reasoning < previous.reasoning;
  if (reset) return { ...current };
  return {
    input: current.input - previous.input,
    cached: current.cached - previous.cached,
    output: current.output - previous.output,
    reasoning: current.reasoning - previous.reasoning,
  };
}

function normalizeArgValue(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/\s+/gu, " ").trim();
  if (Array.isArray(value)) return value.map(normalizeArgValue);
  if (value && typeof value === "object") {
    return normalizeArgs(value as Record<string, unknown>);
  }
  return value;
}

/** Sorted, whitespace-collapsed, volatile keys dropped. Never persisted. */
function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(args).sort()) {
    if (VOLATILE_ARG_KEYS.has(key.toLowerCase())) continue;
    out[key] = normalizeArgValue(args[key]);
  }
  return out;
}

/**
 * The identity of "this call again". The arguments themselves are hashed and
 * dropped: the loop detector needs equality, not content.
 *
 * Nothing is not an identity. An empty argument record hashes to one constant
 * that every argument-less call would share, so it returns null instead and
 * the caller decides what else, if anything, identifies the item.
 */
export function fingerprintArgs(
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args) return null;
  // Measured on what is actually hashed: `JSON.stringify` drops undefined
  // values, so a record of nothing but undefined is a record of nothing.
  const json = JSON.stringify(normalizeArgs(args));
  if (json === "{}") return null;
  return createHash("sha256").update(json).digest("hex");
}

type AnyItem = { type: string; id: string } & Record<string, unknown>;

function itemName(item: AnyItem): string {
  if (item.type === "toolCall") {
    const tool = typeof item.tool === "string" ? item.tool : "tool";
    const server = typeof item.server === "string" ? item.server : null;
    return server ? `${server}:${tool}` : tool;
  }
  if (item.type === "extension" && typeof item.kind === "string") {
    return item.kind;
  }
  return item.type;
}

function itemPath(item: AnyItem): string | null {
  if (typeof item.path === "string") return item.path;
  if (Array.isArray(item.changes)) {
    const first = item.changes[0] as { path?: unknown } | undefined;
    if (first && typeof first.path === "string") return first.path;
  }
  return null;
}

/** Whatever the host gave us as this item's input, or null when it gave none. */
function itemInput(item: AnyItem): Record<string, unknown> | null {
  if (item.type === "toolCall") {
    const args = item.arguments;
    return args && typeof args === "object"
      ? (args as Record<string, unknown>)
      : null;
  }
  // A command IS its arguments, so the command string is fingerprinted the
  // same way and, like tool arguments, never stored.
  if (item.type === "commandExecution" && typeof item.command === "string") {
    return { command: item.command };
  }
  if (item.type === "search" && typeof item.query === "string") {
    return { mode: item.mode, query: item.query };
  }
  return null;
}

/**
 * Arguments alone will not do. bb emits `arguments: {}` for its built-in
 * `search` and `read` tools - the input never arrives, under this or any other
 * key - so hashing them made a thousand distinct searches one fingerprint and
 * the loop rule called them a loop. The name and the path qualify a real
 * input, and on file items they are the whole of it. With neither an input nor
 * a path there is no identity to record: null leaves the item unfingerprinted,
 * which the watch rules already skip.
 */
function itemFingerprint(item: AnyItem): string | null {
  const input = itemInput(item);
  const inputFingerprint = input === null ? null : fingerprintArgs(input);
  const path = itemPath(item);
  if (inputFingerprint === null && path === null) return null;
  return fingerprintArgs({
    input: inputFingerprint,
    name: itemName(item),
    path,
  });
}

const TOOL_ITEM_TYPES = new Set([
  "toolCall",
  "commandExecution",
  "webSearch",
  "webFetch",
  "search",
]);

function scopeTurnId(row: ThreadEventRow): string | null {
  return row.scope.kind === "turn" ? row.scope.turnId : null;
}

function limitCarry<T>(map: Record<string, T>): Record<string, T> {
  const keys = Object.keys(map);
  if (keys.length <= CARRY_TURN_LIMIT) return map;
  const kept = keys.slice(keys.length - CARRY_TURN_LIMIT);
  const out: Record<string, T> = {};
  for (const key of kept) out[key] = map[key] as T;
  return out;
}

function isoOrNull(ms: number | null | undefined): string | null {
  return typeof ms === "number" ? new Date(ms).toISOString() : null;
}

/**
 * Fold a page of events into thread, turn and item patches.
 *
 * `rootThreadId` is passed in rather than derived: the registry owns the tree
 * walk, and denormalizing the root onto every turn is what lets the rollups be
 * one indexed scan instead of a recursive query.
 */
export function normalizeEvents(args: {
  threadId: string;
  events: readonly ThreadEventRow[];
  carry: NormalizeCarry;
  rootThreadId?: string | null;
}): NormalizeResult {
  const { threadId, events } = args;
  const carry: NormalizeCarry = {
    ...args.carry,
    usageByTurn: { ...args.carry.usageByTurn },
    countersByTurn: { ...args.carry.countersByTurn },
  };
  const thread: ThreadPatch = { thread_id: threadId };
  const turns = new Map<string, TurnPatch>();
  const items: ItemPatch[] = [];
  let lastSeq: number | null = null;

  const turnPatch = (turnId: string): TurnPatch => {
    let patch = turns.get(turnId);
    if (!patch) {
      patch = {
        thread_id: threadId,
        turn_id: turnId,
        root_thread_id: args.rootThreadId ?? null,
        // Every turn is born without a proven cache split. Saying so here,
        // rather than only on turn/started, is what keeps a turn first seen
        // mid-flight (the watermark landed after its start) out of the NULL
        // state the coverage view cannot classify. The store keeps an
        // existing value, so this never overwrites a join's proof.
        split_source: "unavailable",
      };
      turns.set(turnId, patch);
    }
    return patch;
  };

  const counters = (turnId: string): TurnCounters => {
    let value = carry.countersByTurn[turnId];
    if (!value) {
      value = { tool_calls: 0, file_changes: 0, file_reads: 0 };
      carry.countersByTurn[turnId] = value;
    }
    return value;
  };

  for (const row of events) {
    lastSeq = lastSeq === null ? row.seq : Math.max(lastSeq, row.seq);
    const at = isoOrNull(row.createdAt);
    const scoped = scopeTurnId(row);
    // A thread-scoped event belongs to whichever turn is open at its seq.
    const openTurn = scoped ?? carry.openTurnId;

    switch (row.type) {
      case "thread/identity": {
        thread.provider_thread_id = row.data.providerThreadId;
        break;
      }
      case "client/turn/requested": {
        const execution = row.data.execution as
          | { model?: unknown; reasoningLevel?: unknown }
          | undefined;
        if (execution && typeof execution.model === "string") {
          carry.modelRequested = execution.model;
        }
        if (execution && typeof execution.reasoningLevel === "string") {
          carry.effort = execution.reasoningLevel;
        }
        // Recorded, not applied. A request names the model for the turn it is
        // about to open; applying it to whatever turn happens to be running
        // would relabel an already-finished turn with the NEXT one's model.
        break;
      }
      case "client/turn/rejected": {
        // The request never became a turn, so its model must not leak into
        // the next turn that starts.
        carry.modelRequested = null;
        carry.effort = null;
        break;
      }
      case "turn/started": {
        const turnId = scoped;
        if (!turnId) break;
        const patch = turnPatch(turnId);
        patch.seq_started = row.seq;
        patch.started_at = at;
        patch.model_requested = carry.modelRequested;
        patch.effort = carry.effort;
        if (row.data.providerThreadId) {
          thread.provider_thread_id = row.data.providerThreadId;
        }
        carry.openTurnId = turnId;
        // A new turn closes the previous turn's trailing-usage window.
        carry.lastCompletedTurnId = null;
        break;
      }
      case "turn/completed": {
        const turnId = scoped ?? carry.openTurnId;
        if (!turnId) break;
        const patch = turnPatch(turnId);
        patch.seq_completed = row.seq;
        patch.completed_at = at;
        if (patch.started_at && at) {
          patch.duration_ms =
            Date.parse(at) - Date.parse(patch.started_at as string);
        }
        // The error MESSAGE is deliberately dropped; the status is the fact.
        if (row.data.status === "failed") {
          patch.error_category = patch.error_category ?? "turn-failed";
        } else if (row.data.status === "interrupted") {
          patch.error_category = patch.error_category ?? "turn-interrupted";
        }
        if (carry.openTurnId === turnId) carry.openTurnId = null;
        carry.lastCompletedTurnId = turnId;
        break;
      }
      case "thread/tokenUsage/updated": {
        const total = row.data.tokenUsage.total;
        const current: TokenTotals = {
          input: total.inputTokens,
          cached: total.cachedInputTokens,
          output: total.outputTokens,
          reasoning: total.reasoningOutputTokens,
        };
        const step = delta(current, carry.totals);
        carry.totals = current;
        // The baseline has already advanced, so a usage event with no open
        // turn is spend that WILL otherwise be charged to the next turn. It
        // belongs to the turn that just finished.
        const usageTurn = openTurn ?? carry.lastCompletedTurnId;
        if (!usageTurn) break;
        const accumulated = carry.usageByTurn[usageTurn] ?? {
          input: 0,
          cached: 0,
          output: 0,
          reasoning: 0,
        };
        const next: TokenTotals = {
          input: accumulated.input + step.input,
          cached: accumulated.cached + step.cached,
          output: accumulated.output + step.output,
          reasoning: accumulated.reasoning + step.reasoning,
        };
        carry.usageByTurn[usageTurn] = next;
        const patch = turnPatch(usageTurn);
        patch.input_tokens = next.input;
        patch.cached_input_tokens = next.cached;
        patch.output_tokens = next.output;
        patch.reasoning_tokens = next.reasoning;
        if (row.data.tokenUsage.modelContextWindow !== null) {
          patch.context_window = row.data.tokenUsage.modelContextWindow;
        }
        break;
      }
      case "thread/contextWindowUsage/updated": {
        if (!openTurn) break;
        const patch = turnPatch(openTurn);
        patch.context_used = row.data.contextWindowUsage.usedTokens;
        patch.context_window =
          row.data.contextWindowUsage.modelContextWindow ??
          patch.context_window ??
          null;
        break;
      }
      case "thread/compacted":
      case "thread/context/cleared": {
        // The next usage total starts from zero. Forgetting the baseline here
        // is what stops the guard in `delta` from having to be a heuristic.
        carry.totals = null;
        if (openTurn) turnPatch(openTurn).compacted = 1;
        break;
      }
      case "provider/error": {
        if (!openTurn) break;
        const patch = turnPatch(openTurn);
        patch.error_category = row.data.errorInfo?.category ?? "unknown";
        patch.will_retry = row.data.willRetry === true ? 1 : 0;
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = row.data.item as unknown as AnyItem;
        const completed = row.type === "item/completed";
        const status =
          typeof item.status === "string"
            ? item.status
            : completed
              ? "completed"
              : "pending";
        const path = itemPath(item);
        const fingerprint = itemFingerprint(item);
        // started/completed are two halves of one row, and each half only
        // knows its own timestamp. Emitting the other as an explicit null is
        // how `item/completed` used to erase the `started_at` that
        // `item/started` had just proved, so the absent half is OMITTED.
        items.push({
          item_id: item.id,
          thread_id: threadId,
          turn_id: openTurn,
          seq: row.seq,
          kind: item.type,
          name: itemName(item),
          status,
          ...(completed ? { completed_at: at } : { started_at: at }),
          // Likewise for the fields only one half carries: a `completed`
          // payload that omits the path must not blank the path `started`
          // recorded, so an unknown value is left out rather than nulled.
          ...(typeof item.durationMs === "number"
            ? { duration_ms: item.durationMs }
            : {}),
          ...(path === null ? {} : { path }),
          ...(fingerprint === null ? {} : { input_fingerprint: fingerprint }),
          ...(typeof item.error === "string" ? { error: "error" } : {}),
        });
        if (completed && openTurn) {
          const counter = counters(openTurn);
          if (TOOL_ITEM_TYPES.has(item.type)) counter.tool_calls += 1;
          if (item.type === "fileChange") {
            counter.file_changes += Array.isArray(item.changes)
              ? item.changes.length
              : 1;
          }
          if (item.type === "fileRead") counter.file_reads += 1;
          const patch = turnPatch(openTurn);
          patch.tool_calls = counter.tool_calls;
          patch.file_changes = counter.file_changes;
          patch.file_reads = counter.file_reads;
        }
        break;
      }
      default:
        break;
    }
  }

  carry.usageByTurn = limitCarry(carry.usageByTurn);
  carry.countersByTurn = limitCarry(carry.countersByTurn);

  return { thread, turns: [...turns.values()], items, carry, lastSeq };
}
