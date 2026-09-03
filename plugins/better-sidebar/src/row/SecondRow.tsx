import { Fragment, useLayoutEffect, useRef, type ReactNode } from "react";
import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { Glyph } from "../ui/Glyph";
import type { RenderRow } from "../model/types";
import { PrChip } from "./PrChip";
import { ProjectGlyph } from "./ProjectGlyph";
import { ProviderGlyph } from "./ProviderGlyph";
import { ROW2_ICON } from "./row-metrics";

/**
 * B41, resolved against B14 by §7: the stale gradient lives on row 2 and the
 * section header only, never on the row-1 title, and it floors at
 * `opacity-70` so `OLDER` stays legible. `dimLevel: 0` emits no class at all,
 * so a row in a section the user is working in carries no opacity whatsoever.
 */
const DIM_CLASS: Record<RenderRow["dimLevel"], string> = {
  0: "",
  1: "opacity-90",
  2: "opacity-80",
  3: "opacity-70",
};

/**
 * Row 2 for a ROOT row: project, branch, model and effort, then the PR chip.
 *
 * Every label carries its own mark, and each is independently hideable — by
 * setting or by absent data — so the line is assembled from whatever survives.
 * It reads left to right, except for the PR chip: that is pinned to the
 * trailing edge so the numbers form one column down the list rather than
 * starting at a different x on every row, wherever that row's branch ended.
 */
export function SecondRow({
  row,
  pullRequest,
  isCompactViewport,
  onOpenPullRequest,
  providerId,
  showProjectName,
  showBranch,
  showEffort,
  execution,
}: {
  row: RenderRow;
  pullRequest: PluginSidebarPullRequest | null;
  isCompactViewport: boolean;
  onOpenPullRequest: () => void;
  /** The provider whose mark rides on the model label; null draws none. */
  providerId: string | null;
  showProjectName: boolean;
  showBranch: boolean;
  /** B84: the effort half of the model label, after the dot. */
  showEffort: boolean;
  /**
   * Model and effort, already gated by `showModel`. Null while the lookup is
   * in flight, when the thread never ran, and when the setting is off.
   */
  execution: { model: string; reasoningLevel: string } | null;
}) {
  /*
   * The labels as a LIST. Every one of them is independently hideable —
   * through settings or absent from the data — so the line is assembled from
   * whatever survives rather than written out inline with gaps in it.
   */
  const labels: { id: string; node: ReactNode }[] = [];

  if (row.projectName !== null && showProjectName) {
    labels.push({
      id: "project",
      node: (
        <Label
          id="project"
          glyph={<ProjectGlyph projectId={row.thread.projectId} className={MARK_CLASS} />}
        >
          {row.projectName}
        </Label>
      ),
    });
  }

  if (row.workspaceLabel !== null && showBranch) {
    labels.push({
      id: "branch",
      node: (
        <Label
          id="branch"
          glyph={<Glyph name="git-branch" className={MARK_CLASS} aria-hidden />}
        >
          {row.workspaceLabel}
        </Label>
      ),
    });
  }

  if (execution !== null) {
    labels.push({
      id: "model",
      node: (
        <Label
          id="model"
          // The mark belongs to the model, not to the line: it says which
          // agent ran this, which is the same fact the model names. It also
          // means one setting governs both.
          glyph={
            providerId === null ? null : (
              <ProviderGlyph providerId={providerId} size="small" />
            )
          }
        >
          {/* Model and effort stay ONE text node. Split into two spans, with
              the spacing carried by `gap`, the line's accessible text
              collapsed to `claude-opus-5low`. The pair reads as one fact.
              B84: the effort half is settable away, and the node stays one
              either way — the bare model, or the pair. */}
          {showEffort
            ? `${execution.model} · ${execution.reasoningLevel}`
            : execution.model}
        </Label>
      ),
    });
  }

  const lineRef = useEqualTruncation();

  return (
    <div
      ref={lineRef}
      className={cn(
        // Whitespace alone divides the labels. Each one already carries its
        // own mark, and a dot between two marked labels stacks a second
        // divider onto a line that is 10px tall.
        //
        // `overflow-hidden` is the hard stop: `min-w-0` lets the labels shrink
        // to their content, and this clips whatever the last of them cannot
        // give up, so the line can never paint past the row's inset.
        "flex min-w-0 items-center gap-1.5 overflow-hidden text-2xs text-muted-foreground/70",
        DIM_CLASS[row.dimLevel],
      )}
    >
      {labels.map((label) => (
        <Fragment key={label.id}>{label.node}</Fragment>
      ))}

      {pullRequest === null ? null : (
        <span className="ml-auto shrink-0">
          <PrChip
            pullRequest={pullRequest}
            isCompactViewport={isCompactViewport}
            onOpen={onOpenPullRequest}
          />
        </span>
      )}
    </div>
  );
}

/** Every mark on the line, at the line's own size and never squeezed. */
const MARK_CLASS = cn(ROW2_ICON, "shrink-0");

/**
 * Equal truncation, not proportional.
 *
 * Flexbox splits a line's deficit in proportion to `flex-shrink ×
 * flex-basis`, and with `flex-basis: auto` the basis is natural width, so
 * the default contract loses the most from the longest label: a long branch
 * starved while a short project kept every character. CSS alone cannot
 * invert that weighting, because the basis is only known once the text is
 * laid out. So it is measured: each pass unshrinks every label, reads its
 * natural width, and gives back a shrink of `BASE / natural`, which makes
 * every label's `shrink × basis` product the same — the same number of
 * pixels comes off each one, however long it is.
 *
 * `MIN_LABEL_PX` is the floor where equal stops: the mark, one character and
 * the ellipsis. Past that a short label would be erased outright, so flexbox
 * freezes it at its min size and redistributes what it spared among the
 * labels that still have room — still equally among themselves.
 */
const SHRINK_BASE = 1000;

/** The mark (`size-2.5`), the mark-to-text gap, one character and the ellipsis. */
const MIN_LABEL_PX = 28;

/** The shrink weight that makes a label of `natural` px lose px equally. */
export function equalShrinkWeight(natural: number): number {
  return natural > 0 ? SHRINK_BASE / natural : 1;
}

/**
 * Measures the line's labels and pins each one's equal-truncation weight.
 *
 * Runs after every render, with no dependency array: the labels and their
 * text change between renders (settings, execution lookups) and each change
 * needs a re-measure. A sidebar resize re-lays-out nothing in React, so a
 * `ResizeObserver` on the line re-runs the same pass. Both paths run before
 * paint, so the unconstrained pass-1 layout is never on screen.
 */
function useEqualTruncation() {
  const lineRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const line = lineRef.current;
    if (line === null) return;

    const equalize = () => {
      const labels = Array.from(
        line.querySelectorAll<HTMLElement>("[data-better-sidebar-row2]"),
      );

      // Pass 1: unshrink everything, so each label is laid out at its own
      // natural width and `offsetWidth` reports it. The reads in pass 2
      // force the synchronous reflow that resolves it.
      for (const el of labels) el.style.flexShrink = "0";

      for (const el of labels) {
        const natural = el.offsetWidth;
        if (natural <= 0) {
          // Nothing was laid out: a hidden row, or a test DOM with no
          // layout engine. Fall back to the class default rather than pin
          // a weight onto a guess.
          el.style.flexShrink = "";
          el.style.minWidth = "";
          continue;
        }
        el.style.flexShrink = String(equalShrinkWeight(natural));
        // `min()` keeps the floor from padding a label wider than its own
        // content when the label is shorter than the floor already.
        el.style.minWidth = `${Math.min(MIN_LABEL_PX, natural)}px`;
      }
    };

    equalize();

    // One observer per row, on the line itself: the measured box IS this
    // element, and a shared observer would need a per-element registry with
    // the same bookkeeping. Kept deliberately; the per-row cost is one
    // observer watching one box.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(equalize);
    observer.observe(line);
    return () => observer.disconnect();
  });

  return lineRef;
}

/**
 * One label on row 2: a mark, then text that truncates.
 *
 * Superseding B56.1 and B56.2, which between them made the branch the ONE
 * shrinkable label. That gave a narrow panel no way to share the loss: the
 * branch was starved to its bare glyph while the project rendered in full,
 * and the model — pinned `shrink-0` behind it — simply overflowed the panel
 * with nothing left to take the deficit.
 *
 * Every label is shrinkable now, and none of them caps its own width. The
 * split between them is `useEqualTruncation`'s: each label gives up the SAME
 * number of pixels, however long it is, rather than the flex default of
 * losing in proportion to natural width, so a long branch never starves a
 * short project to a stub while it still has characters to spare.
 *
 * `min-w-0` on the label is what allows it below its content at all, and the
 * mark stays `shrink-0` so the text loses characters rather than the mark
 * losing pixels.
 */
function Label({
  id,
  glyph,
  children,
}: {
  id: string;
  glyph: ReactNode;
  children: ReactNode;
}) {
  return (
    <span
      data-better-sidebar-row2={id}
      className="flex min-w-0 shrink items-center gap-0.5"
    >
      {glyph}
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * Row 2 for a CHILD row.
 *
 * B52.1 gave a child no second line because its project and branch only
 * repeat its parent's. Model and effort do not: a parent spawns subagents on
 * whatever model it picked for each, and that is the one fact about a child
 * the parent's own row cannot tell you. So the line exists again, carrying
 * different content rather than the same content indented.
 *
 * It is also where the provider mark lives on a child, which is why this
 * component exists at all — the mark moved to row 2, and a child had no row 2
 * to put it on.
 */
export function ChildSecondRow({
  row,
  providerId,
  showEffort,
  execution,
}: {
  row: RenderRow;
  /** The provider whose mark rides on the model label; null draws none. */
  providerId: string | null;
  /** B84: the effort half of the model label, after the dot. */
  showEffort: boolean;
  /** null while the lookup is in flight, and when the thread never ran. */
  execution: { model: string; reasoningLevel: string } | null;
}) {
  return (
    <div
      className={cn(
        // `gap-0.5`, matching the mark-to-model spacing on a root row: the
        // pair is the same pair, so it sits at the same distance.
        "flex min-w-0 items-center gap-0.5 text-2xs text-muted-foreground/70",
        DIM_CLASS[row.dimLevel],
      )}
    >
      {/* B71.3, revised: the mark belongs to the model, so an unresolved
          execution now drops both rather than leaving a mark with nothing to
          qualify. A placeholder for a model nobody chose is still never
          drawn. */}
      {execution === null ? null : (
        <>
          {providerId === null ? null : (
            <ProviderGlyph providerId={providerId} size="small" />
          )}
          <span className="min-w-0 truncate">
            {showEffort
              ? `${execution.model} · ${execution.reasoningLevel}`
              : execution.model}
          </span>
        </>
      )}
    </div>
  );
}
