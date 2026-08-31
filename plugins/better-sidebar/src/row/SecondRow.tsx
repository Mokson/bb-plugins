import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { Glyph } from "../ui/Glyph";
import type { RenderRow } from "../model/types";
import { PrChip } from "./PrChip";
import { ProviderGlyph } from "./ProviderGlyph";
import { ROW2_ICON } from "./icon-sizes";

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
 * Row 2: `project · workspace · PR chip`, on root rows only (B52).
 *
 * Time and the provider glyph both left this line for row 1 (B51.2, B51.4).
 * The line reads left to right, except for the PR chip: it is pinned to the
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
  execution,
}: {
  row: RenderRow;
  pullRequest: PluginSidebarPullRequest | null;
  isCompactViewport: boolean;
  onOpenPullRequest: () => void;
  /** B59's `showProviderGlyph`, already resolved: null draws no mark. */
  providerId: string | null;
  showProjectName: boolean;
  showBranch: boolean;
  /**
   * Model and effort, already gated by `showModel`. Null while the lookup is
   * in flight, when the thread never ran, and when the setting is off.
   */
  execution: { model: string; reasoningLevel: string } | null;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground/70",
        DIM_CLASS[row.dimLevel],
      )}
    >
      {/* The provider mark leads the line, at the small size: it sits in a
          `text-2xs` row beside the project name and would shout at row 1's
          size. It is the line's first element, so the whole line — mark
          included — begins at the title's x. */}
      {providerId === null ? null : (
        <ProviderGlyph providerId={providerId} size="small" />
      )}

      {/* B56.2: `shrink-0` takes the project name out of the proportional
          shrink that was starving it, and `max-w-[45%]` is the whole of its
          claim — it renders in full inside that share and truncates only when
          it alone exceeds it, never because the branch beside it is long. */}
      {row.projectName === null || !showProjectName ? null : (
        <span className="max-w-[45%] shrink-0 truncate">{row.projectName}</span>
      )}

      {/* B56.1: the only shrinkable child left, so it absorbs the whole
          deficit. It is the longest label, the most repetitive down the list
          and the least identifying, so its tail is the right thing to lose. */}
      {row.workspaceLabel === null || !showBranch ? null : (
        <span className="flex min-w-0 shrink items-center gap-0.5">
          <Glyph name="git-branch" className={cn(ROW2_ICON, "shrink-0")} aria-hidden />
          <span className="truncate">{row.workspaceLabel}</span>
        </span>
      )}

      {/* `ml-auto` pins the chip to the line's trailing edge instead of
          letting it trail the branch, so it sits in one column down the list
          and lands under row 1's own trailing cluster. `shrink-0` keeps it
          whole: the branch beside it is the shrinkable child (B56.1), so a
          long branch truncates rather than squeezing the chip. */}
      {/* After the branch and before the chip. `shrink-0` keeps B56.1 intact:
          the branch stays the ONE shrinkable child, so it absorbs the whole
          deficit rather than the two of them splitting it. */}
      {execution === null ? null : (
        <span className="shrink-0 truncate">
          {execution.model} · {execution.reasoningLevel}
        </span>
      )}

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
  execution,
}: {
  row: RenderRow;
  /** B59's `showProviderGlyph`, already resolved: null draws no mark. */
  providerId: string | null;
  /** null while the lookup is in flight, and when the thread never ran. */
  execution: { model: string; reasoningLevel: string } | null;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground/70",
        DIM_CLASS[row.dimLevel],
      )}
    >
      {providerId === null ? null : (
        <ProviderGlyph providerId={providerId} size="small" />
      )}
      {/* B71.3: an unresolved execution drops the labels and keeps the line's
          mark, rather than drawing a placeholder for a model nobody chose. */}
      {execution === null ? null : (
        <span className="min-w-0 truncate">
          {execution.model} · {execution.reasoningLevel}
        </span>
      )}
    </div>
  );
}
