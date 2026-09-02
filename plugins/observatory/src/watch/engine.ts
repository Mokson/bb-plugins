// Turning findings into signal rows.
//
// One evaluation is a RECONCILE, not an append: the rules describe what is
// true about a thread right now, and this compares that to the episodes
// currently open. A finding with no open row opens one; an open row with no
// matching finding closes. That is the whole state machine, and it is why
// nothing has to remember what fired last tick — the `obs_signal` table is
// the memory, and it survives a plugin reload for free.
import type { ObservatoryStore } from "../core/store.js";
import { parseRuleId, parseSeverity } from "./contract.js";
import type { Ladder, SignalTransition } from "./ladder.js";
import type { WatchQueries } from "./queries.js";
import { dedupeKey, evaluate, type Finding } from "./rules.js";
import type { WatchConfig } from "./settings.js";

export interface EvaluationResult {
  threadId: string;
  opened: number;
  closed: number;
  transitions: SignalTransition[];
}

export interface EngineDeps {
  store: ObservatoryStore;
  queries: WatchQueries;
  ladder: Ladder;
  /** The last resolved config. Refreshed by the sweep, never awaited here. */
  config(): WatchConfig;
  now(): number;
}

export interface WatchEngine {
  /** Evaluate one thread. Synchronous, so two callers cannot interleave. */
  evaluateThread(threadId: string): EvaluationResult | null;
  /** The minute sweep: every active thread, for the time-based rules. */
  sweep(): EvaluationResult[];
  /**
   * Close every open signal whose thread is no longer running, and return the
   * transitions that produced.
   *
   * `evaluateThread` is the reconcile for a LIVE thread: a rule that stopped
   * holding closes its episode. But it only ever runs for threads the sweep
   * considers active, so a thread that went idle, archived or failed while a
   * signal was open left that signal open forever — 235 of 235 open rows in
   * the live database, every one on an idle or errored thread. This is the
   * missing half: a thread that is not running cannot be stalling, so its
   * signals close.
   */
  closeStale(): SignalTransition[];
}

export function createEngine(deps: EngineDeps): WatchEngine {
  function evaluateThread(threadId: string): EvaluationResult | null {
    const config = deps.config();
    if (config.mode === "off") return null;

    const now = deps.now();
    const snapshot = deps.queries.snapshot(threadId, now);
    if (!snapshot) return null;

    const findings = evaluate(snapshot, config);
    const byKey = new Map<string, Finding>();
    for (const finding of findings) {
      byKey.set(dedupeKey(threadId, finding), finding);
    }

    const at = new Date(now).toISOString();
    const transitions: SignalTransition[] = [];
    const open = deps.queries.openSignals(threadId);
    const openKeys = new Set(open.map((row) => row.dedupe_key));

    // Close first. A rule whose episode anchor moved has BOTH a stale open row
    // and a fresh finding this tick, and closing before opening keeps the two
    // transitions in the order a reader would expect.
    for (const row of open) {
      if (byKey.has(row.dedupe_key)) continue;
      deps.store.closeSignal(row.id, at);
      // A row whose `kind` no longer names a live rule is still CLOSED — it is
      // stale by definition — but it gets no transition: the ladder's
      // broadcast is typed on the rule union, and there is nothing truthful to
      // put in it.
      const rule = parseRuleId(row.kind);
      if (!rule) continue;
      transitions.push({
        signalId: row.id,
        threadId,
        rule,
        state: "closed",
        severity: parseSeverity(row.severity),
        evidence: evidenceOf(row.payload) ?? `${row.kind} cleared`,
        at,
      });
    }

    const closed = transitions.length;
    let opened = 0;
    for (const [key, finding] of byKey) {
      if (openKeys.has(key)) continue;
      const signalId = deps.store.openSignal({
        module: "watch",
        kind: finding.rule,
        dedupeKey: key,
        threadId,
        severity: finding.severity,
        openedAt: at,
        payload: { ...finding.payload, evidence: finding.evidence },
      });
      opened += 1;
      transitions.push({
        signalId,
        threadId,
        rule: finding.rule,
        state: "open",
        severity: finding.severity,
        evidence: finding.evidence,
        at,
      });
    }

    for (const transition of transitions) deps.ladder.applyLadder(transition);

    return { threadId, opened, closed, transitions };
  }

  function closeStale(): SignalTransition[] {
    if (deps.config().mode === "off") return [];
    const at = new Date(deps.now()).toISOString();
    const transitions: SignalTransition[] = [];
    for (const row of deps.queries.staleOpenSignals()) {
      deps.store.closeSignal(row.id, at);
      const rule = parseRuleId(row.kind);
      // Same reason as the close branch above: a row whose kind no longer
      // names a live rule is still closed, but there is nothing truthful to
      // put in a broadcast typed on the rule union.
      if (!rule || row.thread_id === null) continue;
      transitions.push({
        signalId: row.id,
        threadId: row.thread_id,
        rule,
        state: "closed",
        severity: parseSeverity(row.severity),
        evidence: evidenceOf(row.payload) ?? `${row.kind} cleared`,
        at,
      });
    }
    for (const transition of transitions) deps.ladder.applyLadder(transition);
    return transitions;
  }

  return {
    evaluateThread,
    closeStale,
    sweep() {
      // Close first. A thread that finished since the last sweep is no longer
      // in `activeThreads`, so nothing below would ever reach its signals.
      closeStale();
      const results: EvaluationResult[] = [];
      for (const thread of deps.queries.activeThreads()) {
        const result = evaluateThread(thread.threadId);
        if (result) results.push(result);
      }
      return results;
    },
  };
}

/** The evidence line stored alongside a signal's payload, when there is one. */
export function evidenceOf(payload: string | null): string | null {
  const parsed = parsePayload(payload);
  if (typeof parsed !== "object" || parsed === null) return null;
  const evidence = (parsed as { evidence?: unknown }).evidence;
  return typeof evidence === "string" ? evidence : null;
}

/** Parsed payload, or null. Shared by the RPC views. */
export function parsePayload(payload: string | null): unknown {
  if (!payload) return null;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    // A payload that is not JSON is a fact about an older row, not an error
    // worth failing an evaluation over.
    return null;
  }
}
