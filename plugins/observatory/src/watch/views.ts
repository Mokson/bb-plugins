// The read models the RPC, the CLI and the panel all render.
//
// One builder per view, taking the queries object rather than a database, so
// the CLI cannot accidentally render a different shape than the panel — the
// same defect `observatory_status` was built to avoid.
import type {
  InboxAction,
  InboxCounts,
  InboxRow,
  InboxSource,
  RuleId,
  Severity,
  SignalView,
  ThreadSignalView,
  WatchRow,
} from "./contract.js";
import { evidenceOf, parsePayload } from "./engine.js";
import type { SignalRowLite, WatchQueries } from "./queries.js";
import { STALL_RULES } from "./rules.js";

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warn: 1,
  info: 2,
};

function severityOf(row: SignalRowLite): Severity {
  const value = row.severity;
  return value === "critical" || value === "warn" || value === "info"
    ? value
    : "warn";
}

function toSignalView(row: SignalRowLite): SignalView {
  return {
    id: row.id,
    kind: row.kind,
    severity: severityOf(row),
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    evidence: evidenceOf(row.payload) ?? row.kind,
    payload: parsePayload(row.payload),
  };
}

export function toThreadSignalView(row: SignalRowLite): ThreadSignalView {
  return { ...toSignalView(row), threadId: row.thread_id };
}

/**
 * The deliver pipeline stage a thread sits in, from the seat its title names
 * (`deliver-implementer` -> `implementer`). Null for anything off-pipeline:
 * inventing a stage for an ad-hoc thread would put a column of "unknown" next
 * to every row that is doing nothing wrong.
 */
export function stageOf(seat: string | null): string | null {
  if (!seat) return null;
  return seat.startsWith("deliver-") ? seat.slice("deliver-".length) : seat;
}

/** One row per active thread, worst open rule first. */
export function buildWatchList(
  queries: WatchQueries,
  now: number,
): { watched: number; rows: WatchRow[] } {
  const threads = queries.activeThreads();
  const rows = threads.map((thread): WatchRow => {
    const snapshot = queries.snapshot(thread.threadId, now);
    const open = queries
      .openSignals(thread.threadId)
      .sort(
        (left, right) =>
          SEVERITY_ORDER[severityOf(left)] - SEVERITY_ORDER[severityOf(right)],
      );
    const worst = open[0] ?? null;
    return {
      threadId: thread.threadId,
      title: thread.title,
      seat: thread.seat,
      state: open.length > 0 ? "stalled" : "healthy",
      silentMs:
        snapshot?.lastEventAt === null || snapshot === null
          ? 0
          : Math.max(0, now - snapshot.lastEventAt),
      inflight: snapshot?.openItem
        ? { kind: snapshot.openItem.kind, name: snapshot.openItem.name }
        : null,
      stage: stageOf(thread.seat),
      rule: worst ? (worst.kind as RuleId) : null,
      diagnostic: worst ? (evidenceOf(worst.payload) ?? worst.kind) : null,
      openedAt: worst?.opened_at ?? null,
    };
  });
  // Stalled threads first, then the quietest: the row a person needs is never
  // below one that is fine.
  rows.sort((left, right) => {
    if (left.state !== right.state) return left.state === "stalled" ? -1 : 1;
    return right.silentMs - left.silentMs;
  });
  return { watched: rows.length, rows };
}

export function buildExplain(queries: WatchQueries, threadId: string) {
  return {
    threadId,
    signals: queries.signalsForThread(threadId).map(toSignalView),
    actions: queries.actionsForThread(threadId),
  };
}

/** Which module opened a row. Unknown modules are dropped, not guessed. */
const SOURCES: Record<string, InboxSource> = {
  watch: "watch",
  spend: "spend",
  audit: "audit",
  eval: "eval",
  distillery: "distillery",
};

/**
 * Actions a row offers. Keyed by module and rule so a new source declares its
 * own affordances instead of inheriting watch's.
 */
function actionsFor(row: SignalRowLite): InboxAction[] {
  if (row.module !== "watch") return ["open", "review"];
  if (row.kind === "tree-budget") return ["open", "escalate"];
  return ["open", "steer"];
}

/** A short human title for the row. The evidence goes in the subtitle. */
function titleFor(row: SignalRowLite): string {
  return row.kind.replace(/-/g, " ");
}

/**
 * Rank: stalled first, then over budget, then newest.
 *
 * The bands are computed from the row rather than hardcoded to watch, because
 * audit, eval and distillery land against this same list and must be
 * rankable without touching this comparator.
 */
function band(row: SignalRowLite): number {
  if (row.module === "watch" && STALL_RULES.has(row.kind as RuleId)) return 0;
  if (row.kind.includes("budget")) return 1;
  return 2;
}

export function buildInbox(
  queries: WatchQueries,
  limit: number,
): { rows: InboxRow[]; counts: InboxCounts } {
  const open = queries
    .openSignalsAllModules()
    .filter((row) => SOURCES[row.module] !== undefined);

  const ranked = [...open].sort((left, right) => {
    const bands = band(left) - band(right);
    if (bands !== 0) return bands;
    const severities =
      SEVERITY_ORDER[severityOf(left)] - SEVERITY_ORDER[severityOf(right)];
    if (severities !== 0) return severities;
    return right.opened_at.localeCompare(left.opened_at);
  });

  const rows = ranked.slice(0, limit).map(
    (row): InboxRow => ({
      id: String(row.id),
      source: SOURCES[row.module] as InboxSource,
      kind: row.kind,
      title: titleFor(row),
      subtitle: evidenceOf(row.payload) ?? row.kind,
      threadId: row.thread_id,
      severity: severityOf(row),
      openedAt: row.opened_at,
      actions: actionsFor(row),
    }),
  );

  const stalledThreads = new Set(
    open
      .filter((row) => band(row) === 0 && row.thread_id !== null)
      .map((row) => row.thread_id as string),
  );

  return {
    rows,
    counts: {
      watched: queries.activeThreads().length,
      stalled: stalledThreads.size,
      overBudget: open.filter((row) => band(row) === 1).length,
      queue: open.length,
    },
  };
}
