// The steer ladder's seam. Phase 2 is rung 0: it RECORDS.
//
// Everything a steer would need is already assembled here — the signal, the
// evidence, the thread, the mode, the cooldown budget — and the one thing this
// file does not do is send. That is deliberate and load-bearing: phase 3 adds
// rungs 1 to 3 inside `applyLadder` and nothing above it changes, and until
// the rung-1 precision data from this phase says otherwise, an observe-only
// build must be provably incapable of touching a running thread.
//
// The invariant, asserted by `test/watch-phase-2-ladder-never-steers.test.ts`:
// nothing in this module calls `threads.send` or `threads.stop`.
import type { ObservatoryStore } from "../core/store.js";
import {
  SIGNAL_CHANNEL,
  type RuleId,
  type Severity,
  type SignalBroadcast,
  type WatchMode,
} from "./contract.js";
import { inQuietHours, type QuietHours } from "./settings.js";

/** Publishes allowed per thread per rolling hour. */
export const PER_THREAD_HOURLY_CAP = 6;
/** Publishes allowed across all threads per rolling hour. */
export const OVERALL_HOURLY_CAP = 20;
const HOUR_MS = 60 * 60 * 1_000;

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

export interface LadderDeps {
  store: ObservatoryStore;
  publish(channel: string, payload: unknown): void;
  /** Re-read per transition: mode is a KV knob and must apply without reload. */
  config(): { mode: WatchMode; quietHours: QuietHours | null };
  now(): number;
  log: { info(message: string): void };
}

export interface Ladder {
  /**
   * Record one signal transition and, budget permitting, tell the UI.
   *
   * Phase 2 stops here. The `obs_action` row is written on EVERY transition
   * and only on a transition — not per tick — so the action table stays the
   * evidence trail of what watch noticed rather than a log of how often it
   * looked.
   */
  applyLadder(transition: SignalTransition): LadderOutcome;
}

export function createLadder(deps: LadderDeps): Ladder {
  /** Publish timestamps, newest last, per thread and overall. */
  const perThread = new Map<string, number[]>();
  let overall: number[] = [];

  function withinCap(threadId: string, now: number): LadderOutcome | null {
    const cutoff = now - HOUR_MS;
    overall = overall.filter((at) => at > cutoff);
    const thread = (perThread.get(threadId) ?? []).filter((at) => at > cutoff);
    perThread.set(threadId, thread);
    if (thread.length >= PER_THREAD_HOURLY_CAP) return "capped-thread";
    if (overall.length >= OVERALL_HOURLY_CAP) return "capped-overall";
    return null;
  }

  return {
    applyLadder(transition): LadderOutcome {
      const { mode, quietHours } = deps.config();
      const now = deps.now();

      // The action row lands first and unconditionally. A notification that
      // was capped or fell in quiet hours is still something watch observed,
      // and losing that row would make the cap look like a missed detection.
      deps.store.recordAction({
        signalId: transition.signalId,
        threadId: transition.threadId,
        action: "observe",
        at: transition.at,
        detail: `${transition.rule} ${transition.state}: ${transition.evidence}`,
        result: transition.state,
      });

      // `off` records nothing at all, so it never reaches here; the guard is
      // kept because mode is read per call and can flip between the scan and
      // this line.
      if (mode === "off") return "mode-off";

      // Phase 3 inserts rungs 1 to 3 HERE, between the recorded evidence and
      // the notification. Nothing below sends a message to a thread.

      if (inQuietHours(quietHours, new Date(now))) {
        // Silently, per the notification contract: a suppressed notification
        // is not a warning, and waking someone to tell them it stayed quiet
        // would defeat the setting.
        return "quiet-hours";
      }
      const capped = withinCap(transition.threadId, now);
      if (capped) return capped;

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
      perThread.get(transition.threadId)?.push(now);
      overall.push(now);
      return "sent";
    },
  };
}
