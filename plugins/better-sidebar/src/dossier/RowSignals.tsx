import type { ReactNode } from "react";
import { Glyph, type GlyphName } from "../ui/Glyph";
import type { RowSignal } from "../server-contract";
import { useRowSignal } from "./useRowSignals";

/** B37: "exceeds 80%". 0.5 draws nothing, 0.85 draws the warning. */
const CONTEXT_PRESSURE_THRESHOLD = 0.8;

/** Geometry of the B40 goal ring, in the same 24×24 box every glyph uses. */
const RING_RADIUS = 9;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * B37-B40. The extra monochrome glyphs that sit in a row's signal cluster,
 * fed by the viewport-bounded `rowSignals` batch. Nothing renders until the
 * row has been scrolled into view at least once (§7's B37-B40 ruling).
 */
export function RowSignals({ threadId }: { threadId: string }) {
  const { ref, signal } = useRowSignal(threadId);
  const goal = signal?.goal ?? null;
  const goalProgress = goalRingProgress(goal);

  return (
    <span
      ref={ref}
      className="flex items-center gap-1 text-muted-foreground/70"
      data-better-sidebar-signals={threadId}
    >
      {signal !== null &&
      signal.contextPressure !== null &&
      signal.contextPressure > CONTEXT_PRESSURE_THRESHOLD ? (
        <Signal
          kind="context-pressure"
          glyph="triangle-alert"
          label={`Context window ${Math.round(signal.contextPressure * 100)}% full`}
        />
      ) : null}

      {signal?.modelFallback ? (
        <Signal
          kind="model-fallback"
          glyph="circle-alert"
          label={`Fell back from ${signal.modelFallback.originalModel} to ${signal.modelFallback.fallbackModel}`}
        />
      ) : null}

      {/* B39 (§7 ruling): its own glyph in the cluster, not a sixth indicator. */}
      {signal?.isRateLimitPaused ? (
        <Signal
          kind="rate-limit-paused"
          glyph="pause"
          label="Paused on a provider rate limit"
        />
      ) : null}

      {goal !== null && goalProgress !== null ? (
        <GoalRing progress={goalProgress} status={goal.status} />
      ) : null}
    </span>
  );
}

function Signal({
  kind,
  glyph,
  label,
}: {
  kind: string;
  glyph: GlyphName;
  label: string;
}): ReactNode {
  return (
    <span data-signal={kind} role="img" aria-label={label}>
      <Glyph name={glyph} aria-hidden="true" />
    </span>
  );
}

/**
 * B40: the ring fills at `tokensUsed / tokenBudget`, and `budgetLimited`
 * renders full regardless of the numbers. A goal with no budget and no
 * budget-limited status has no ratio to draw, so it draws nothing.
 */
function goalRingProgress(goal: RowSignal["goal"]): number | null {
  if (goal === null) return null;
  if (goal.status === "budgetLimited") return 1;
  if (goal.tokenBudget === null || goal.tokenBudget <= 0) return null;
  return Math.min(1, Math.max(0, goal.tokensUsed / goal.tokenBudget));
}

function GoalRing({ progress, status }: { progress: number; status: string }) {
  const percent = Math.round(progress * 100);
  return (
    <span
      data-signal="goal-ring"
      data-goal-progress={String(progress)}
      data-goal-status={status}
      role="img"
      aria-label={`Goal ${percent}% of its token budget`}
    >
      <svg viewBox="0 0 24 24" className="size-3.5" aria-hidden="true">
        <circle
          cx="12"
          cy="12"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          className="opacity-25"
        />
        <circle
          cx="12"
          cy="12"
          r={RING_RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={`${RING_CIRCUMFERENCE * progress} ${RING_CIRCUMFERENCE}`}
          transform="rotate(-90 12 12)"
        />
      </svg>
    </span>
  );
}
