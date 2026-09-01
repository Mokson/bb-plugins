// Cache-miss detection: a prompt prefix stopped being reused, and what did it.
//
// Provider logs carry neither the system prompt nor the tool schemas, so
// nothing here can diff the prefix that actually changed. The cause is
// therefore CORRELATE-based: every observable thing that happened between the
// two turns is collected, and the classification takes the first one in a
// fixed order. The drilldown keeps the whole list, because the ordering is a
// convention and the evidence is not.
//
// The threshold pair is deliberate. A ratio alone fires on tiny turns where a
// 5k read dropping to 1k is noise; an absolute drop alone fires on a large
// thread whose reads merely tapered. Both must hold.
import type { Database } from "better-sqlite3";
import { resolveModel, type PricingCatalog } from "../core/catalog.js";
import type { ObservatoryStore } from "../core/store.js";
import type { CacheMissCause, CacheMissRow, SpendRange } from "./contract.js";
import { parseNameList } from "./fingerprint.js";
import { rangeStart } from "./rollup.js";

/** A read below this share of the prior turn's is a candidate. */
export const CACHE_READ_RATIO = 0.4;
/** ...and only if it also dropped at least this many tokens. */
export const CACHE_DROP_TOKENS = 20_000;
/** Provider cache TTL when the `spend_cacheTtlMinutes` setting is unset. */
export const DEFAULT_CACHE_TTL_MINUTES = 5;
/** The window `recurrence7d` counts over. */
const RECURRENCE_DAYS = 7;
const PER_MILLION = 1_000_000;

/** Classification order. First correlate observed wins. */
export const CAUSE_ORDER: readonly CacheMissCause[] = [
  "compaction",
  "context-cleared",
  "model-switch",
  "idle-expiry",
  "skill-injection",
  "mcp-change",
  "subagent-spawn",
  "first-turn",
  "unknown",
];

export interface Correlate {
  kind: string;
  detail: string;
  at: string;
}

interface TurnRecord {
  thread_id: string;
  turn_id: string;
  provider_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  cache_read_tokens: number | null;
  model_reported: string | null;
  model_requested: string | null;
  compacted: number | null;
  skill_names: string | null;
  mcp_names: string | null;
}

function added(before: readonly string[], after: readonly string[]): string[] {
  const known = new Set(before);
  return after.filter((name) => !known.has(name));
}

function millis(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

export interface CacheMissDeps {
  db: Database;
  store: ObservatoryStore;
  catalog?: PricingCatalog | null;
  /** Provider cache TTL in minutes; an idle gap past it expires the prefix. */
  ttlMinutes?: number;
  now?: () => number;
}

export interface CacheMissQuery {
  range?: SpendRange;
  threadId?: string;
}

/**
 * Every turn in scope, oldest first, with its matched log row's skill and MCP
 * name lists folded in. One query rather than one per turn: the detector runs
 * on the ingest commit path and a per-turn round trip there is what turns a
 * drain tick into a stall.
 */
function loadTurns(
  db: Database,
  query: CacheMissQuery,
  now: number,
): TurnRecord[] {
  const params: Record<string, string> = {};
  let where = "1 = 1";
  if (query.threadId) {
    where += " AND t.thread_id = @threadId";
    params["threadId"] = query.threadId;
  }
  if (query.range) {
    where += " AND t.started_at >= @from";
    params["from"] = rangeStart(query.range, now);
  }
  return db
    .prepare<Record<string, string>, TurnRecord>(
      `SELECT t.thread_id, t.turn_id, th.provider_id, t.started_at,
              t.completed_at, t.cache_read_tokens, t.model_reported,
              t.model_requested, t.compacted,
              lt.skill_names AS skill_names, lt.mcp_names AS mcp_names
         FROM obs_turn t
         JOIN obs_thread th ON th.thread_id = t.thread_id
         LEFT JOIN obs_match m
                ON m.thread_id = t.thread_id AND m.turn_id = t.turn_id
         LEFT JOIN obs_log_turn lt ON lt.log_key = m.log_key
        WHERE ${where}
        ORDER BY t.thread_id, COALESCE(t.started_at, ''), t.turn_id`,
    )
    .all(params);
}

/** Items recorded between two instants on one thread. */
function itemsInGap(
  db: Database,
  threadId: string,
  from: string,
  to: string,
): Array<{ kind: string | null; name: string | null; started_at: string | null }> {
  return db
    .prepare<
      [string, string, string],
      { kind: string | null; name: string | null; started_at: string | null }
    >(
      `SELECT kind, name, started_at FROM obs_item
        WHERE thread_id = ? AND started_at > ? AND started_at <= ?
        ORDER BY started_at`,
    )
    .all(threadId, from, to);
}

function childThreadsInGap(
  db: Database,
  threadId: string,
  from: string,
  to: string,
): Array<{ thread_id: string; created_at: string | null }> {
  return db
    .prepare<
      [string, string, string],
      { thread_id: string; created_at: string | null }
    >(
      `SELECT thread_id, created_at FROM obs_thread
        WHERE parent_thread_id = ? AND created_at > ? AND created_at <= ?`,
    )
    .all(threadId, from, to);
}

const COMPACTION_ITEM = /compact/iu;
const CONTEXT_CLEARED_ITEM = /context[^a-z]?clear/iu;
const SKILL_ITEM = /^skill/iu;

/**
 * Collect every observable correlate in the gap. Order of collection follows
 * {@link CAUSE_ORDER} so the classifier is a `find`, not a switch: adding a
 * correlate means adding it here and to the order, and nothing else.
 */
function correlatesFor(
  db: Database,
  previous: TurnRecord,
  current: TurnRecord,
  options: { ttlMs: number; isFirstPair: boolean },
): Correlate[] {
  const from = previous.completed_at ?? previous.started_at ?? "";
  const to = current.started_at ?? "";
  const items = from && to ? itemsInGap(db, current.thread_id, from, to) : [];
  const found: Correlate[] = [];

  if (current.compacted) {
    found.push({
      kind: "compaction",
      detail: "turn marked compacted",
      at: to,
    });
  }
  for (const item of items) {
    const label = `${item.kind ?? ""} ${item.name ?? ""}`.trim();
    if (COMPACTION_ITEM.test(label)) {
      found.push({ kind: "compaction", detail: label, at: item.started_at ?? to });
    }
    if (CONTEXT_CLEARED_ITEM.test(label)) {
      found.push({
        kind: "context-cleared",
        detail: label,
        at: item.started_at ?? to,
      });
    }
  }

  if (
    previous.model_reported &&
    current.model_reported &&
    previous.model_reported !== current.model_reported
  ) {
    found.push({
      kind: "model-switch",
      detail: `${previous.model_reported} -> ${current.model_reported}`,
      at: to,
    });
  }

  const gapStart = millis(from);
  const gapEnd = millis(to);
  if (gapStart !== null && gapEnd !== null && gapEnd - gapStart > options.ttlMs) {
    found.push({
      kind: "idle-expiry",
      detail: `${Math.round((gapEnd - gapStart) / 1_000)}s idle`,
      at: to,
    });
  }

  const newSkills = added(
    parseNameList(previous.skill_names),
    parseNameList(current.skill_names),
  );
  const skillItems = items.filter((item) =>
    SKILL_ITEM.test(`${item.kind ?? ""}`) || SKILL_ITEM.test(`${item.name ?? ""}`),
  );
  if (newSkills.length > 0 || skillItems.length > 0) {
    const names =
      newSkills.length > 0
        ? newSkills.join(", ")
        : skillItems.map((item) => item.name ?? "skill").join(", ");
    found.push({ kind: "skill-injection", detail: names, at: to });
  }

  const newMcp = added(
    parseNameList(previous.mcp_names),
    parseNameList(current.mcp_names),
  );
  if (newMcp.length > 0) {
    found.push({ kind: "mcp-change", detail: newMcp.join(", "), at: to });
  }

  const children = from && to ? childThreadsInGap(db, current.thread_id, from, to) : [];
  for (const child of children) {
    found.push({
      kind: "subagent-spawn",
      detail: child.thread_id,
      at: child.created_at ?? to,
    });
  }

  if (options.isFirstPair) {
    found.push({
      kind: "first-turn",
      detail: "prior turn is the thread's first",
      at: to,
    });
  }
  return found;
}

function classify(correlates: readonly Correlate[]): CacheMissCause {
  return (
    CAUSE_ORDER.find((cause) =>
      correlates.some((correlate) => correlate.kind === cause),
    ) ?? "unknown"
  );
}

/** Drop tokens repriced from the cache-read rate up to the full input rate. */
function estimateUsd(
  catalog: PricingCatalog | null,
  provider: string | null,
  model: string | null,
  drop: number,
): number | null {
  if (!catalog) return null;
  const price = resolveModel(catalog, provider ?? "", model)?.price;
  if (!price) return null;
  const delta = price.input - price.cacheRead;
  return delta > 0 ? (drop * delta) / PER_MILLION : 0;
}

/** The signal identity. Same turn, same episode, however often it is scanned. */
export function cacheMissDedupeKey(threadId: string, turnId: string): string {
  return `spend:cache-miss:${threadId}:${turnId}`;
}

/**
 * Detect misses in scope and open a signal for each.
 *
 * Idempotent by construction: `openSignal` conflicts on the dedupe key and
 * returns the existing episode, so re-running over the same turns writes no
 * second row. That matters because this runs on every thread drain.
 */
export function detectCacheMisses(
  deps: CacheMissDeps,
  query: CacheMissQuery = {},
): CacheMissRow[] {
  const now = (deps.now ?? Date.now)();
  const ttlMs = (deps.ttlMinutes ?? DEFAULT_CACHE_TTL_MINUTES) * 60 * 1_000;
  const catalog = deps.catalog ?? null;
  const turns = loadTurns(deps.db, query, now);
  const rows: CacheMissRow[] = [];

  // The query already orders by thread then time, so grouping is a fold: a
  // hand-rolled index walk over the flat array needed a cast per read and
  // said nothing the Map does not.
  const byThread = new Map<string, TurnRecord[]>();
  for (const turn of turns) {
    const bucket = byThread.get(turn.thread_id);
    if (bucket) bucket.push(turn);
    else byThread.set(turn.thread_id, [turn]);
  }

  for (const [threadId, thread] of byThread) {
    for (let position = 1; position < thread.length; position += 1) {
      const previous = thread[position - 1] as TurnRecord;
      const current = thread[position] as TurnRecord;
      const prior = previous.cache_read_tokens;
      const read = current.cache_read_tokens;
      // An unproven split is not a drop. Only turns whose reads are both
      // KNOWN can be compared, or the detector would fire on missing data.
      if (prior === null || read === null) continue;
      const drop = prior - read;
      if (drop <= CACHE_DROP_TOKENS) continue;
      if (read >= prior * CACHE_READ_RATIO) continue;

      const correlates = correlatesFor(deps.db, previous, current, {
        ttlMs,
        isFirstPair: position === 1,
      });
      const at = current.started_at ?? new Date(now).toISOString();
      rows.push({
        threadId,
        ...(current.provider_id ? { provider: current.provider_id } : {}),
        turnId: current.turn_id,
        prevTurnId: previous.turn_id,
        at,
        priorCacheRead: prior,
        cacheRead: read,
        drop,
        estimatedUsd: estimateUsd(
          catalog,
          current.provider_id,
          current.model_reported ?? current.model_requested,
          drop,
        ),
        cause: classify(correlates),
        correlates,
        recurrence7d: 0,
      });
    }
  }

  // Recurrence is a property of the SET, so it is filled once the whole scan
  // is done. Rows are already grouped by thread and ascending in time, so a
  // sliding window does it in one pass; the pairwise scan it replaces was
  // quadratic in the number of misses a 90-day range turns up.
  const windowMs = RECURRENCE_DAYS * 24 * 60 * 60 * 1_000;
  let windowStart = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] as CacheMissRow;
    const at = millis(row.at);
    if (at === null) {
      row.recurrence7d = 1;
      continue;
    }
    if (index > 0 && (rows[index - 1] as CacheMissRow).threadId !== row.threadId) {
      windowStart = index;
    }
    while (windowStart < index) {
      const edge = millis((rows[windowStart] as CacheMissRow).at);
      if (edge !== null && at - edge <= windowMs) break;
      windowStart += 1;
    }
    row.recurrence7d = index - windowStart + 1;
  }

  for (const row of rows) {
    deps.store.openSignal({
      module: "spend",
      kind: "cache-miss",
      dedupeKey: cacheMissDedupeKey(row.threadId, row.turnId),
      threadId: row.threadId,
      turnId: row.turnId,
      severity: row.cause === "unknown" ? "info" : "warn",
      openedAt: row.at,
      payload: row,
    });
  }
  return rows;
}
