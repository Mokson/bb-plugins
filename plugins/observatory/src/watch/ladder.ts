// The steer ladder.
//
// Four rungs over one decision: rung 0 records, rung 1 sends one steer per
// signal, rung 2 sends a second only when a DIFFERENT rule fires, rung 3
// escalates to the parent thread and publishes on `observatory/escalation`.
// Phase 2 shipped rung 0 alone and proved the ladder could not touch a running
// thread; phase 3 adds the sends, and the guards that make them safe are the
// reason this file is longer than the rungs are.
//
// Three properties everything here is arranged around.
//
// 1. RECORD BEFORE SEND. The `obs_action` row for a steer is written
//    synchronously, before the send is even scheduled. A steer that reached a
//    thread and left no trace is the one failure mode that would make the
//    evidence table a lie; a recorded steer whose send then failed is merely a
//    row with `result: "send-failed"`.
// 2. NEVER STOP. Nothing in `src/watch` calls `threads.stop`, `cancel` or
//    `interrupt`, and `test/steer-never-stops-a-thread.test.ts` greps this
//    directory to keep it that way. The plugin advises; it does not terminate.
// 3. SYNCHRONOUS DECISION, SERIALIZED SEND. `applyLadder` stays synchronous so
//    the engine's concurrency argument holds (better-sqlite3 does not yield, so
//    a drain-triggered evaluation and a sweep-triggered one cannot interleave).
//    The sends it schedules run one at a time on a single promise chain, so two
//    steers decided in one tick have a defined order rather than racing.
import type { ObservatoryStore } from "../core/store.js";
import {
  ESCALATION_CHANNEL,
  RULE_IDS,
  SIGNAL_CHANNEL,
  type EscalationBroadcast,
  type RuleId,
  type Severity,
  type SignalBroadcast,
  type WatchMode,
} from "./contract.js";
import { STEER_ELIGIBLE_RULES } from "./rules.js";
import { inQuietHours, type QuietHours } from "./settings.js";

/** Publishes allowed per thread per rolling hour. */
export const PER_THREAD_HOURLY_CAP = 6;
/** Publishes allowed across all threads per rolling hour. */
export const OVERALL_HOURLY_CAP = 20;
/** One steer per thread per this window, unless a different rule fires. */
export const STEER_COOLDOWN_MS = 10 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

/**
 * Titles watch refuses to steer regardless of visibility.
 *
 * `obs_thread.visibility` is the primary guard and `origin` the second, but
 * both are written by core from what bb reports, and an older row can carry
 * neither. A thread that eval or distillery drives announces itself in its
 * title, so the prefix is the belt to those two braces.
 */
export const RESERVED_TITLE_PREFIXES = [
  "[eval]",
  "[distillery]",
  "[observatory]",
] as const;

/** Thread origins watch never steers: those runs are owned by another module. */
const RESERVED_ORIGINS = new Set(["eval", "distillery"]);

export interface SignalTransition {
  signalId: number;
  threadId: string;
  rule: RuleId;
  state: "open" | "closed";
  severity: Severity;
  evidence: string;
  /** ISO instant the transition was observed. */
  at: string;
}

/** Why a transition did not reach the UI. `sent` means it did. */
export type LadderOutcome =
  | "sent"
  | "quiet-hours"
  | "capped-thread"
  | "capped-overall"
  | "mode-off";

/**
 * What the ladder did about a signal, or why it did nothing. Every value is
 * written verbatim into `obs_action.result`, so this union is also the
 * vocabulary a reader of the evidence table sees.
 */
export type SteerVerdict =
  | "steered"
  | "escalated"
  | "queued"
  | "mode-off"
  | "observe-only"
  | "rule-not-steerable"
  | "closed-signal"
  | "cooldown"
  | "unknown-thread"
  | "inactive-thread"
  | "reserved-thread"
  | "quiet-hours"
  | "capped-thread"
  | "capped-overall"
  | "send-failed";

/** The thread facts every guard reads, resolved once per decision. */
export interface ThreadContext {
  threadId: string;
  title: string;
  status: string | null;
  visibility: string | null;
  origin: string | null;
  parentThreadId: string | null;
  rootThreadId: string;
  /** Wall time since the thread's most recent turn or item, for the diagnostic. */
  silentMs: number | null;
}

export interface LadderSendArgs {
  threadId: string;
  text: string;
  /**
   * `steer` interrupts the running turn; `queue-if-active` waits for it to
   * finish. Those are the SDK's own names (`sendMessageRequestSchema.mode`);
   * there is no bare `queue` member, so the premise reminder — which the spec
   * describes as queued — uses `queue-if-active`.
   */
  mode: "steer" | "queue-if-active";
}

export interface LadderDeps {
  store: ObservatoryStore;
  publish(channel: string, payload: unknown): void;
  /** Re-read per transition: mode is a KV knob and must apply without reload. */
  config(): { mode: WatchMode; quietHours: QuietHours | null };
  now(): number;
  log: { info(message: string): void; error(message: string): void };
  /** Resolves the guards' facts. Null when the thread is not in the ledger. */
  thread(threadId: string): ThreadContext | null;
  /**
   * The rule each ladder send on this thread named, strictly after `since`.
   *
   * Null for a manual steer, which names no rule, and that null is meaningful:
   * a human steer must not consume a rule's rung.
   */
  steeredRules(threadId: string, since: string): Array<RuleId | null>;
  /** Ladder sends counted for the caps: this thread, and every thread. */
  steerCounts(
    threadId: string,
    since: string,
  ): { thread: number; overall: number };
  /** The one call that touches a running thread. */
  send(args: LadderSendArgs): Promise<unknown>;
}

export interface ManualSteerOptions {
  /** The line the person wants delivered. Defaults to a generic check-in. */
  note?: string;
  /** Set on the recorded row so the trail says a human asked. */
  actor?: string;
}

export interface Ladder {
  /**
   * Record one signal transition, tell the UI, and climb the ladder.
   *
   * The `obs_action` row is written on EVERY transition and only on a
   * transition — not per tick — so the action table stays the evidence trail of
   * what watch noticed rather than a log of how often it looked. The return
   * value is the NOTIFICATION outcome; what the ladder did about the steer is
   * in the second row it writes, because that row is what a reader goes
   * looking for.
   */
  applyLadder(transition: SignalTransition): LadderOutcome;
  /** A person asking for one steer. Same record-before-send path. */
  steer(threadId: string, options?: ManualSteerOptions): Promise<SteerVerdict>;
  /** A person asking for one escalation to the parent. Same path. */
  escalate(
    threadId: string,
    options?: ManualSteerOptions,
  ): Promise<SteerVerdict>;
  /** Send one queued, non-interrupting message. The premise reminder's path. */
  queue(threadId: string, text: string, action: string): Promise<SteerVerdict>;
  /** Resolves once every send this ladder scheduled has settled. */
  settled(): Promise<void>;
}

const RULE_SET: ReadonlySet<string> = new Set(RULE_IDS);

/**
 * The rule a recorded ladder detail names, for the rung-2 "different rule"
 * test. Details are written as `<rule>: <evidence>`, so the first token is the
 * rule; a manual steer names no rule and yields null, which is right — a human
 * steer must not consume a rule's rung.
 */
export function ruleOfDetail(detail: string | null): RuleId | null {
  if (!detail) return null;
  const first = detail.split(":", 1)[0]?.trim() ?? "";
  return RULE_SET.has(first) ? (first as RuleId) : null;
}

function elapsed(ms: number | null): string {
  if (ms === null) return "an unknown time";
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The steer text. It names the rule, the numbers the rule counted, and how long
 * the thread has been quiet, because a steer that says only "you seem stuck"
 * costs the agent a turn working out what was meant.
 *
 * It also admits it may be wrong. A false positive that reads as an order is
 * far more expensive than one that reads as a note.
 */
export function steerDiagnostic(
  rule: RuleId,
  evidence: string,
  context: ThreadContext,
): string {
  return [
    `[observatory] ${rule}: ${evidence}.`,
    `No new turn or tool activity for ${elapsed(context.silentMs)}.`,
    "If you are stuck, say what you are blocked on and try a different",
    "approach. If this is expected work, ignore this note and carry on.",
  ].join(" ");
}

/** The escalation text sent to the PARENT, which carries the child's evidence. */
export function escalationDiagnostic(
  rule: RuleId,
  evidence: string,
  child: ThreadContext,
): string {
  return [
    `[observatory] escalation from child thread ${child.threadId}`,
    `(${child.title}): ${rule} — ${evidence}.`,
    `Quiet for ${elapsed(child.silentMs)}.`,
    "Decide whether that child should continue, be re-scoped, or be told",
    "what it is missing.",
  ].join(" ");
}

export function createLadder(deps: LadderDeps): Ladder {
  /**
   * Every scheduled send, chained. Serialization is the point: two steers
   * decided in the same tick would otherwise land in an order set by the event
   * loop, and the second could reach a thread the first had already
   * redirected. The chain also gives tests and teardown one thing to await.
   */
  let chain: Promise<void> = Promise.resolve();

  /**
   * The notification budget, counted off the `obs_action` rows this ladder
   * itself wrote.
   *
   * Durable on purpose: an in-memory window resets on every plugin reload, so
   * a crash loop would hand out a fresh six-per-thread allowance each time,
   * and the maps it needed never evicted a thread that went quiet.
   */
  function withinCap(threadId: string, now: number): LadderOutcome | null {
    const since = new Date(now - HOUR_MS).toISOString();
    const published = deps.store.publishedActionsSince(since, threadId);
    if (published.thread >= PER_THREAD_HOURLY_CAP) return "capped-thread";
    if (published.overall >= OVERALL_HOURLY_CAP) return "capped-overall";
    return null;
  }

  /**
   * Whether this transition reaches the UI, and why not when it does not.
   *
   * Decided BEFORE the action row is written, because that row is what the
   * cap counts: `result` has to hold the verdict this returns.
   */
  function decide(threadId: string, now: number): LadderOutcome {
    const { mode, quietHours } = deps.config();
    // `off` records nothing at all, so it never reaches here; the guard is
    // kept because mode is read per call and can flip between the scan and
    // this line.
    if (mode === "off") return "mode-off";
    // Silently, per the notification contract: a suppressed notification is
    // not a warning, and waking someone to tell them it stayed quiet would
    // defeat the setting.
    if (inQuietHours(quietHours, new Date(now))) return "quiet-hours";
    return withinCap(threadId, now) ?? "sent";
  }

  /** True when this thread belongs to another module, or to nobody. */
  function isReserved(context: ThreadContext): boolean {
    if (context.visibility === "hidden") return true;
    if (context.origin && RESERVED_ORIGINS.has(context.origin)) return true;
    return RESERVED_TITLE_PREFIXES.some((prefix) =>
      context.title.startsWith(prefix),
    );
  }

  /**
   * Which rules this thread has already been steered about inside the
   * cooldown. Rung 1 is the first; rung 2 is a second under a different rule;
   * a third distinct rule escalates.
   */
  function priorRules(threadId: string, now: number): Set<RuleId> {
    const since = new Date(now - STEER_COOLDOWN_MS).toISOString();
    const rules = new Set<RuleId>();
    for (const rule of deps.steeredRules(threadId, since)) {
      if (rule) rules.add(rule);
    }
    return rules;
  }

  /**
   * The steer budget, counted off the ladder's OWN sent rows rather than
   * shared with the notification budget: an observe build publishes six
   * notifications an hour per thread, and a steer build must not therefore be
   * left with none.
   */
  function withinSteerCap(threadId: string, now: number): SteerVerdict | null {
    const since = new Date(now - HOUR_MS).toISOString();
    const counts = deps.steerCounts(threadId, since);
    if (counts.thread >= PER_THREAD_HOURLY_CAP) return "capped-thread";
    if (counts.overall >= OVERALL_HOURLY_CAP) return "capped-overall";
    return null;
  }

  interface RecordThenSend {
    verdict: SteerVerdict;
    action: string;
    signalId: number | null;
    /** Where the row is filed: the thread the evidence is ABOUT. */
    subjectThreadId: string;
    /** Where the message goes. Differs from the subject on an escalation. */
    targetThreadId: string;
    detail: string;
    /** Null means "record the refusal and send nothing". */
    text: string | null;
    mode: LadderSendArgs["mode"];
    at: string;
  }

  /**
   * Write the row, then schedule the send. Never the other way round, and
   * never merged into one statement where a later refactor could reorder them.
   * `test/steer-recorded-before-sent.test.ts` asserts the row is already
   * readable from inside the send stub.
   */
  function recordThenSend(input: RecordThenSend): SteerVerdict {
    const actionId = deps.store.recordAction({
      signalId: input.signalId,
      threadId: input.subjectThreadId,
      action: input.action,
      at: input.at,
      detail: input.detail,
      result: input.verdict,
    });
    if (input.text === null) return input.verdict;

    const text = input.text;
    chain = chain.then(async () => {
      try {
        await deps.send({
          threadId: input.targetThreadId,
          text,
          mode: input.mode,
        });
      } catch (error) {
        // The first row already says the ladder decided to send. A second row
        // carries the failure rather than rewriting it, so the trail keeps
        // both the decision and its outcome.
        deps.store.recordAction({
          signalId: input.signalId,
          threadId: input.subjectThreadId,
          action: input.action,
          at: new Date(deps.now()).toISOString(),
          detail: `${input.detail} (send failed after action ${actionId})`,
          result: "send-failed",
        });
        deps.log.error(
          `[watch] ${input.action} ${input.targetThreadId} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
    return input.verdict;
  }

  /**
   * Rung 3. The target is the parent, or the root when no parent is recorded —
   * and never past the root, so an escalation on a top-level thread addresses
   * that thread rather than nobody.
   */
  function escalateTransition(
    transition: SignalTransition,
    context: ThreadContext,
    at: string,
    detail: string,
  ): SteerVerdict {
    const target =
      context.parentThreadId ?? context.rootThreadId ?? context.threadId;
    const verdict = recordThenSend({
      verdict: "escalated",
      action: "escalate",
      signalId: transition.signalId,
      subjectThreadId: transition.threadId,
      targetThreadId: target,
      detail: `${detail} -> ${target}`,
      text: escalationDiagnostic(transition.rule, transition.evidence, context),
      mode: "steer",
      at,
    });
    const broadcast: EscalationBroadcast = {
      threadId: transition.threadId,
      targetThreadId: target,
      rootThreadId: context.rootThreadId,
      kind: transition.rule,
      severity: transition.severity,
      evidence: transition.evidence,
      at,
    };
    deps.publish(ESCALATION_CHANNEL, broadcast);
    // The row status the thread list reads, on the channel it already
    // subscribes to, so escalation needs no second listener in the app.
    const status: SignalBroadcast = {
      threadId: transition.threadId,
      kind: transition.rule,
      state: "open",
      severity: transition.severity,
      evidence: transition.evidence,
    };
    deps.publish(SIGNAL_CHANNEL, status);
    return verdict;
  }

  /**
   * Rungs 1 to 3 for one automatic transition.
   *
   * Every refusal leaves a row too. "Watch saw this and chose not to steer" is
   * the answer somebody wants at 2am, and an unrecorded refusal is
   * indistinguishable from a rule that never fired.
   */
  function climb(transition: SignalTransition): SteerVerdict {
    const now = deps.now();
    const at = new Date(now).toISOString();
    const { mode, quietHours } = deps.config();
    const detail = `${transition.rule}: ${transition.evidence}`;
    const refuse = (verdict: SteerVerdict): SteerVerdict =>
      recordThenSend({
        verdict,
        action: "steer",
        signalId: transition.signalId,
        subjectThreadId: transition.threadId,
        targetThreadId: transition.threadId,
        detail,
        text: null,
        mode: "steer",
        at,
      });

    // Three early returns that write NO row. The notification path already
    // recorded the transition, and a second row saying "watch is in its
    // default mode" on every signal would double the action table forever
    // while answering a question nobody asks. Once the mode IS steer, every
    // refusal below is recorded, because then "why did it not steer" is
    // exactly the question.
    if (transition.state === "closed") return "closed-signal";
    if (mode === "off") return "mode-off";
    if (mode === "observe") return "observe-only";
    if (!STEER_ELIGIBLE_RULES.has(transition.rule)) {
      return refuse("rule-not-steerable");
    }

    const context = deps.thread(transition.threadId);
    if (!context) return refuse("unknown-thread");
    if (context.status !== "active") return refuse("inactive-thread");
    if (isReserved(context)) return refuse("reserved-thread");
    if (inQuietHours(quietHours, new Date(now))) return refuse("quiet-hours");

    const capped = withinSteerCap(transition.threadId, now);
    if (capped) return refuse(capped);

    const prior = priorRules(transition.threadId, now);
    // Rung 1 has no prior. Rung 2 needs a DIFFERENT rule; the same rule inside
    // the cooldown is the same complaint twice.
    if (prior.has(transition.rule)) return refuse("cooldown");

    // Rung 3: a third distinct rule inside the cooldown, or a subtree budget
    // breach, is not this thread's problem to solve alone. Both go to the
    // parent, the thread that can re-scope the work. PRODUCT invariant 23:
    // tree budget cannot veto a spawn, so it steers the parent instead.
    const treeBreach =
      transition.rule === "tree-budget" &&
      transition.evidence.startsWith("subtree");
    if (prior.size >= 2 || treeBreach) {
      return escalateTransition(transition, context, at, detail);
    }

    return recordThenSend({
      verdict: "steered",
      action: "steer",
      signalId: transition.signalId,
      subjectThreadId: transition.threadId,
      targetThreadId: transition.threadId,
      detail,
      text: steerDiagnostic(transition.rule, transition.evidence, context),
      mode: "steer",
      at,
    });
  }

  function settled(): Promise<void> {
    return chain;
  }

  /** The shared body of the two manual entry points. */
  async function manual(
    threadId: string,
    action: "steer" | "escalate",
    options: ManualSteerOptions,
  ): Promise<SteerVerdict> {
    const now = deps.now();
    const at = new Date(now).toISOString();
    const detail = `manual ${action}${options.actor ? ` by ${options.actor}` : ""}`;
    const refuse = (verdict: SteerVerdict): SteerVerdict =>
      recordThenSend({
        verdict,
        action,
        signalId: null,
        subjectThreadId: threadId,
        targetThreadId: threadId,
        detail,
        text: null,
        mode: "steer",
        at,
      });

    // Mode still governs. Someone steering from `observe` is asking for the
    // mode change first, and silently overriding it would make the setting a
    // suggestion. The rule eligibility gate does NOT apply: a person who read
    // the evidence is the judgement that gate stands in for.
    const mode = deps.config().mode;
    if (mode !== "steer") {
      return refuse(mode === "off" ? "mode-off" : "observe-only");
    }
    const context = deps.thread(threadId);
    if (!context) return refuse("unknown-thread");
    if (context.status !== "active") return refuse("inactive-thread");
    if (isReserved(context)) return refuse("reserved-thread");
    // The caps apply: a budget that a click can walk past is not a budget, and
    // a repeated click is exactly the shape of the accident it guards against.
    // Quiet hours do NOT — they protect a sleeping person from a notification,
    // and the person clicking this is demonstrably awake.
    const capped = withinSteerCap(threadId, now);
    if (capped) return refuse(capped);

    const target =
      action === "escalate"
        ? (context.parentThreadId ?? context.rootThreadId ?? threadId)
        : threadId;
    const note =
      options.note ??
      (action === "escalate"
        ? `[observatory] escalation for child thread ${threadId} (${context.title}), quiet for ${elapsed(context.silentMs)}. Decide whether it should continue or be re-scoped.`
        : `[observatory] check-in on this thread, quiet for ${elapsed(context.silentMs)}. If you are stuck, say what you are blocked on.`);

    const verdict = recordThenSend({
      verdict: action === "escalate" ? "escalated" : "steered",
      action,
      signalId: null,
      subjectThreadId: threadId,
      targetThreadId: target,
      detail: `${detail} -> ${target}`,
      text: note,
      mode: "steer",
      at,
    });
    if (action === "escalate") {
      const broadcast: EscalationBroadcast = {
        threadId,
        targetThreadId: target,
        rootThreadId: context.rootThreadId,
        kind: null,
        severity: "warn",
        evidence: detail,
        at,
      };
      deps.publish(ESCALATION_CHANNEL, broadcast);
    }
    // A manual caller is a CLI process or a click that shows a confirmation,
    // so it waits for the send rather than reporting a verdict the send has
    // not reached yet.
    await settled();
    return verdict;
  }

  return {
    applyLadder(transition): LadderOutcome {
      const now = deps.now();
      const outcome = decide(transition.threadId, now);

      // The action row lands on every transition, capped or not: a
      // notification that was suppressed is still something watch observed,
      // and losing that row would make the cap look like a missed detection.
      // `result` carries the outcome, which is also what the cap counts.
      deps.store.recordAction({
        signalId: transition.signalId,
        threadId: transition.threadId,
        action: "observe",
        at: transition.at,
        detail: `${transition.rule} ${transition.state}: ${transition.evidence}`,
        result: outcome,
      });

      // The ladder climbs whether or not the notification published. Quiet
      // hours silence a desktop notification, and separately silence a steer
      // through `climb`'s own check; suppressing one must not suppress the
      // other by accident. `mode-off` is the exception, because off means off.
      if (outcome !== "mode-off") climb(transition);

      if (outcome !== "sent") return outcome;

      // Typed against the schema the app parses this channel with, so a
      // field renamed here fails the build rather than the subscriber.
      const broadcast: SignalBroadcast = {
        threadId: transition.threadId,
        kind: transition.rule,
        state: transition.state,
        severity: transition.severity,
        evidence: transition.evidence,
      };
      deps.publish(SIGNAL_CHANNEL, broadcast);
      return "sent";
    },

    steer: (threadId, options = {}) => manual(threadId, "steer", options),
    escalate: (threadId, options = {}) => manual(threadId, "escalate", options),

    async queue(threadId, text, action): Promise<SteerVerdict> {
      const at = new Date(deps.now()).toISOString();
      const refuse = (verdict: SteerVerdict): SteerVerdict =>
        recordThenSend({
          verdict,
          action,
          signalId: null,
          subjectThreadId: threadId,
          targetThreadId: threadId,
          detail: action,
          text: null,
          mode: "queue-if-active",
          at,
        });
      // A queued message is still a message. `observe` records and never
      // sends, so the reminder needs `steer` mode as much as a steer does.
      const mode = deps.config().mode;
      if (mode !== "steer") {
        return refuse(mode === "off" ? "mode-off" : "observe-only");
      }
      const context = deps.thread(threadId);
      if (!context) return refuse("unknown-thread");
      if (isReserved(context)) return refuse("reserved-thread");
      const verdict = recordThenSend({
        verdict: "queued",
        action,
        signalId: null,
        subjectThreadId: threadId,
        targetThreadId: threadId,
        detail: action,
        text,
        // Queued, not steered: a premise reminder is context for the next
        // turn, not an interruption of this one.
        mode: "queue-if-active",
        at,
      });
      await settled();
      return verdict;
    },

    settled,
  };
}
