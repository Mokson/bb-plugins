import { memo, type MouseEvent } from "react";
import { toast } from "sonner";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  useBbNavigate,
  type PluginSidebarPullRequest,
} from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { Glyph } from "../ui/Glyph";
import { RowHover } from "../dossier/RowHover";
import { RowSignals } from "../dossier/RowSignals";
import { RowContextMenu } from "../menu/RowContextMenu";
import { useRenameEditor } from "../menu/useRenameEditor";
import type { RenderRow } from "../model/types";
import { RowActions } from "./RowActions";
import { LEADING_COLUMN_CLASS, ROW1_ICON } from "./row-metrics";
import { relativeTimeLabel } from "./relative-time";
import { ChildSecondRow, SecondRow } from "./SecondRow";
import { StatusGlyph } from "./StatusGlyph";

/** B9: one indent step per parent hop, in px so the truncation stays honest. */
const DEPTH_INDENT_PX = 12;

/**
 * The row's own horizontal inset, applied INSIDE its rounded background and
 * equal on both sides.
 *
 * Superseding B57.3 and B73.2, which between them left the leading mark flush
 * against the background's left edge and the time flush against its right:
 * the highlight then read as a bar the content was sitting on rather than a
 * surface holding it. The scroll container's own 8px column (B73.1) still
 * separates that background from the panel edge, so the row nests one inset
 * inside another, as bb's own list does.
 *
 * B74, against bb's own 8px: Max asked for tighter side paddings on the nav
 * item, and the inset halves to 4px. The container's 8px column is untouched
 * — that is the panel's gutter, and the hover background keeps its distance
 * from the panel edge — so a row's content sits 12px from each edge instead
 * of 16px.
 *
 * One constant drives both sides, because the whole point is that they match:
 * `paddingLeft` also carries the depth indent, so writing the right side as a
 * class would put the two halves of one decision in two places.
 */
const ROW_INSET_PX = 4;

/**
 * B57.2, superseding B51.1: the chevron's box, drawn only on a parent row and
 * placed immediately after the title rather than in a reserved gutter. Nothing
 * is reserved on a childless row, so B57.5's alignment comes from removal.
 * `relative` is what the hit area's `-inset-1.5` measures against.
 */
const CHEVRON_BOX_CLASS =
  cn("relative flex shrink-0 items-center justify-center", ROW1_ICON);


/** B51.5: a fixed slot per trailing element, so the time column aligns down the list. */
const TRAILING_TEXT_CLASS =
  // Row 2's colour: the time is metadata about the thread, not part of its
  // title, so it sits at the same weight as the project and branch below it.
  "shrink-0 text-right text-[11px] tabular-nums text-muted-foreground/70";

export interface ThreadRowProps {
  row: RenderRow;
  /** Quantized clock, shared by every row in one render. */
  now: number;
  /**
   * B82: epoch ms of the thread's newest event, from the list's batched
   * lookup. `undefined` until it lands, or when the lookup failed, and the row
   * falls back to `thread.updatedAt` — a record write, which lags real work.
   */
  lastActivityAt?: number;
  /** B19/B60, decided by the list from `density` and the group mode. */
  showSecondRow: boolean;
  /**
   * Model and effort for row 2, from the list's batched lookup, on a root row
   * and a child alike. `null` while it is in flight, when the thread never
   * ran, and when `showModel` is off — the label and its provider mark are
   * then both dropped.
   */
  execution?: { model: string; reasoningLevel: string } | null;
  /** B61.1: `false` skips `experimental_useSidebarThreadPullRequest` entirely. */
  showPrChip?: boolean;
  /** B85: which quick actions the hover cluster draws. */
  quickActions?: { pin: boolean; markRead: boolean; archive: boolean };
  /** B59: row 2's project name and branch. */
  showProjectName?: boolean;
  showBranch?: boolean;
  /** B84: row 2's effort, the half of the model label after the dot. */
  showEffort?: boolean;
  /** B59: the row's own relative time, at the right edge. */
  showRelativeTime?: boolean;
  /** B61.2: `false` mounts no `IntersectionObserver` and sends no `rowSignals`. */
  showSignals?: boolean;
  /** The thread-list slot prop; the list owns it, the row only forwards it. */
  isCompactViewport: boolean;
  /** B47: called after every thread open, so the drawer closes and search clears. */
  onNavigate: () => void;
  /**
   * The row is the thread the route currently shows. The list decides it from
   * its own `activeThreadId` slot prop; on a non-thread route no row is active.
   */
  isActive?: boolean;
  /** B10; supplied by the list, which owns the persisted collapse state. */
  isSubtreeCollapsed?: boolean;
  onToggleSubtree?: () => void;
}

/**
 * One sidebar row: row 1, row 2, and the host contract that makes both usable.
 *
 * This is the integration point for the four cross-slice seams — `RowHover`,
 * `RowSignals`, `RowContextMenu` and `useRenameEditor` — so no other slice has
 * to reach into this file.
 *
 * Memoized over its own props (§6). Every row mounts, always, in visual order:
 * B44's nine numbered shortcuts address rows by their mounted DOM nodes, so a
 * windowed list would silently select the wrong thread after a scroll. Thread
 * objects keep their identity while their entry is unchanged, so a memoized
 * row re-renders only when its own thread changed, which is what keeps a full
 * mount affordable as the array identity churns.
 */
export const ThreadRow = memo(function ThreadRow(props: ThreadRowProps) {
  // A hook cannot be called conditionally, and §6 wants the PR subscription
  // skipped entirely for a thread with no environment — a thread with no
  // environment has no branch and therefore can have no PR. Two components,
  // chosen by a value that changes at most once in a thread's life, is how
  // that gate is expressed without breaking the rules of hooks. B61.1 rides
  // the same gate: with `showPrChip: false` the hook has no call site at all.
  return props.showPrChip === false || props.row.thread.environment === null ? (
    <RowBody {...props} pullRequest={null} />
  ) : (
    <RowWithPullRequest {...props} />
  );
});

function RowWithPullRequest(props: ThreadRowProps) {
  const { pullRequest } = useSidebarThreadPullRequest(props.row.thread.id);
  return <RowBody {...props} pullRequest={pullRequest} />;
}

function RowBody({
  row,
  now,
  lastActivityAt,
  showSecondRow,
  execution = null,
  showProjectName = true,
  showBranch = true,
  showEffort = true,
  showRelativeTime = true,
  showSignals = true,
  quickActions = { pin: true, markRead: false, archive: true },
  isCompactViewport,
  onNavigate,
  isActive = false,
  isSubtreeCollapsed = false,
  onToggleSubtree,
  pullRequest,
}: ThreadRowProps & { pullRequest: PluginSidebarPullRequest | null }) {
  const { thread } = row;
  const actions = useSidebarThreadActions();
  const navigate = useBbNavigate();
  const { splitProps } = useSidebarThreadSplit(thread.id);
  const renameEditor = useRenameEditor(thread.id);

  const openThread = () => {
    actions.open(thread.id);
    onNavigate();
  };

  const openPullRequest = () => {
    if (pullRequest === null) return;
    // B36 (§7): openUrl honours the client's own browser preference rather
    // than guaranteeing a new tab, and it can decline outright. A row is the
    // wrong place to grow an error line — it would shift every row below it —
    // so a refusal surfaces as a toast, the way bb's own sidebar reports one.
    if (!navigate.openUrl(pullRequest.url)) {
      toast.error("Could not open the pull request");
    }
  };

  const toggleSubtree = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    onToggleSubtree?.();
  };

  return (
    <RowContextMenu
      thread={thread}
      title={row.title}
      pullRequest={pullRequest}
      isCompleted={row.isCompleted}
      onNavigate={onNavigate}
      onOpenPullRequest={openPullRequest}
      renameEditor={renameEditor}
    >
      {/* Three nested elements, each one load-bearing.
          - This wrapper is the context menu's `asChild` trigger, and it is
            also the one real DOM element that has to sit between it and the
            hover card's trigger: nesting one Radix root directly inside
            another's trigger silently drops the outer one's handlers.
          - `RowHover` owns the row's box, because hover intent has to be
            observed on the element that contains the anchor.
          - The anchor is `absolute inset-0`, bb's own row pattern
            (`.bb-refs/bb-sidebar/src/SlimRow.tsx:78-96`). The host's shortcut
            collector accepts a match **only** when it is an
            `HTMLAnchorElement`; a `<div role="button">` carrying the same two
            attributes yields zero targets and all nine numbered / next /
            previous shortcuts silently do nothing. */}
      <div data-better-sidebar-row={thread.id} className="mb-1">
        <RowHover
          row={row}
          isCompactViewport={isCompactViewport}
          // B54: bb's own row is 28px tall with `0 0 0 8px` padding and a 13px
          // text size. Row 1 carries the height itself, so a root row with no
          // second row measures exactly one bb row.
          className={cn(
            // B73.2: `pr-2` is gone. The container's right inset now ends the
            // row, so the trailing time and the section count share one edge.
            // `group/row` is what the hover cluster and the fading
            // trailing indicator both key off.
            "group/row relative w-full min-w-0 rounded-md text-left text-[13px]",
            "hover:bg-accent/60 focus-within:ring-1 focus-within:ring-ring",
            // The route's own row keeps a full-strength accent, so it stays
            // distinct from the 60% wash hover paints. `hover:bg-accent` holds
            // it there while the pointer is over it: twMerge keeps the later
            // class of a group, so hovering an active row does not dim it.
            isActive && "bg-accent hover:bg-accent",
          )}
          // The base inset is symmetric (`ROW_INSET_PX`); the per-depth indent
          // adds to the left only, because B9 needs a child to read as sitting
          // under its parent.
          style={{
            paddingLeft: ROW_INSET_PX + row.depth * DEPTH_INDENT_PX,
            paddingRight: ROW_INSET_PX,
          }}
        >
          <a
            href="#"
            // B44: both attributes, on the interactive element, in visual
            // order. Omitting either — or making it anything but an anchor —
            // silently breaks bb's nine sidebar shortcuts.
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            aria-label={row.title}
            aria-current={isActive ? "true" : undefined}
            className="absolute inset-0 cursor-pointer rounded-md focus-visible:outline-none"
            onClick={(event) => {
              event.preventDefault();
              openThread();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openThread();
              }
            }}
            // B45: the host owns every rule of the split gesture; the row's
            // only job is to spread the props onto the same element it made
            // clickable.
            {...splitProps}
          />

          {/* Above the anchor and transparent to the pointer, so a click
              anywhere on the row reaches it. The few genuinely interactive
              children opt back in individually. */}
          <div className="pointer-events-none relative flex min-w-0 flex-col">
            {/* Row 1 —
                [status] title [chevron, parents only] … [signals] [time].

                The leading column carries the STATUS mark now; the provider
                mark moved down to row 2's matching column. Status is the
                thing that changes and the thing you scan for, so it takes
                the position the eye already lands on. */}
            <div data-better-sidebar-row1="" className="flex h-7 min-w-0 items-center gap-2">
              {/* The column is reserved whether or not it draws — idle is the
                  common row and status draws nothing for it — so every title
                  keeps its x whatever the row's state. */}
              <span className={LEADING_COLUMN_CLASS}>
                <StatusGlyph thread={thread} />
              </span>

              {renameEditor.isRenaming ? (
                <input
                  {...renameEditor.inputProps}
                  className="pointer-events-auto min-w-0 flex-1 rounded-sm border border-border bg-background px-1 text-xs"
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                />
              ) : (
                // B14: unread is font weight and nothing else. No opacity, no
                // separate dot — a faded resting row makes most of a list read
                // as disabled. B15: no pin glyph; the PINNED section says it.
                // Roots only: a child thread is a subagent the user never
                // opens, so its unread flag is noise on every parent's subtree.
                <span
                  className={cn(
                    // Revised B51.5 with B57.2: intrinsic rather than
                    // `flex-1`, so the chevron sits against the end of the
                    // title instead of being pushed to the row's edge. The
                    // trailing cluster keeps the right edge with `ml-auto`,
                    // and the title still truncates only when it runs out.
                    "min-w-0 truncate",
                    row.depth === 0 && thread.isUnread
                      ? "font-semibold"
                      : "font-normal",
                  )}
                >
                  {row.title}
                </span>
              )}

              {/* B57.1/B57.2: the chevron hugs the end of the title, and it is
                  the only signal that a thread has children — the per-row count
                  is gone. Its x therefore varies row to row, which is correct:
                  only a parent draws one, so there is no column to break. */}
              {row.childCount === 0 ? null : (
                <span className={cn(CHEVRON_BOX_CLASS, "-ml-1")}>
                  <span
                    role="button"
                    tabIndex={-1}
                    aria-label={
                      isSubtreeCollapsed
                        ? `Expand ${row.childCount} child threads`
                        : `Collapse ${row.childCount} child threads`
                    }
                    aria-expanded={!isSubtreeCollapsed}
                    // B55.4: the hit area is grown with `-inset-1.5` rather
                    // than with padding, so a thumb-sized target costs the
                    // layout nothing and the row's own tap survives beside it.
                    className="pointer-events-auto absolute -inset-1.5 flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                    onClick={toggleSubtree}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <Glyph
                      name={isSubtreeCollapsed ? "chevron-right" : "chevron-down"}
                      className={ROW1_ICON}
                      aria-hidden
                    />
                  </span>
                </span>
              )}

              {/* B51.3: the trailing cluster, in order. B55.2: it never wraps —
                  the title truncates into it instead.

                  Revised B51.5: only TIME is a fixed slot, because time is the
                  only element present on every row and therefore the only one
                  that can define a stable column. Everything before it is
                  intrinsic and absent when it has nothing to say, so an idle
                  childless row — the common row — gives all of that width back
                  to its title. That is also why the spacing is a margin on each
                  element rather than a `gap` on the cluster: a gap would still
                  be charged for `RowSignals`, which must stay mounted even when
                  it draws nothing (its observer is what discovers it has
                  something to draw).

                  B57.4: that one margin is `ml-1.5` on every element that
                  draws, and on none that does not, so status-to-time measures
                  the same on every row whatever its siblings do. B57.1: the
                  child count is gone from here and from the row entirely. */}
              <div
                data-better-sidebar-row-trailing=""
                className={cn(
                  "ml-auto flex shrink-0 items-center",
                  // The indicator gives its PLACE to the actions, not just its
                  // paint: it leaves the flow so the cluster inherits exactly
                  // the width it had. Faded with `opacity-0` it kept its width
                  // and the title had to clear both.
                  //
                  // `RowSignals` is unmounted from layout with it, which costs
                  // nothing: `runBatch` filters on staleness, so the row
                  // rejoining the visible set sends no request while its entry
                  // is fresh.
                  "group-hover/row:hidden",
                  "group-focus-within/row:hidden",
                  "group-has-[[data-state=open]]/row:hidden",
                )}
              >
                {/* B61.2: at `compact` and `default` this is not mounted, so
                    no observer exists and no `rowSignals` request is sent. */}
                {/* B86.5: search suspends grouping, so a filed thread arrives
                    among the active ones with no COMPLETED header to explain
                    it. The check says so on the row itself. Outside search the
                    section already says it, and a mark on every row of a
                    section says nothing. */}
                {row.isCompleted && row.sectionKey === "search" ? (
                  <Glyph
                    name="check"
                    aria-label="Completed"
                    className={cn(ROW1_ICON, "ml-1.5 text-muted-foreground")}
                  />
                ) : null}
                {/* B86.2: the thread was written to after it was filed. The one
                    row in the pile worth a second look, and the reason a
                    background agent finishing does not have to unfile it. */}
                {row.hasUpdateSinceCompleted ? (
                  <Glyph
                    name="dot"
                    aria-label="Updated since completed"
                    className={cn(ROW1_ICON, "ml-1.5 text-foreground")}
                  />
                ) : null}
                {showSignals ? <RowSignals threadId={thread.id} /> : null}
                {/* B51.4: the row's own time, on every row, at the right edge.
                    With time hidden the trailing cluster is fully intrinsic —
                    B51.5's fixed slot has no anchor left to pin. */}
                {showRelativeTime ? (
                  <span className={cn(TRAILING_TEXT_CLASS, "ml-1.5 w-7")}>
                    {relativeTimeLabel(lastActivityAt ?? thread.updatedAt, now)}
                  </span>
                ) : null}
              </div>

              {/* Last child of row 1, so it lands exactly where the trailing
                  indicator was and the title measures against it. */}
              <RowActions
                thread={thread}
                title={row.title}
                pullRequest={pullRequest}
                isCompleted={row.isCompleted}
                quickActions={quickActions}
                onNavigate={onNavigate}
                onOpenPullRequest={openPullRequest}
                renameEditor={renameEditor}
                onOpen={(split) =>
                  split
                    ? actions.open(thread.id, { split: true })
                    : actions.open(thread.id)
                }
              />
            </div>

            {/* B52.1, revised: a child DOES draw a second line, but not the
                same one. Its project and workspace repeat its parent's, so
                the line carries the model and effort its parent spawned it on
                instead — the one fact a child's row can add.

                The WHOLE line starts at the title's x: the 22px indent puts
                its first element — the provider mark — under the title
                rather than out in row 1's status gutter. */}
            {showSecondRow ? (
              // `-mt-1` closes 4px of the ~5px gap row 1's fixed 28px box
              // leaves under a 13px title. It is taken here rather than off
              // row 1's height, so a row with no second line still measures
              // exactly one bb row (B54).
              <div className="-mt-1 pb-1 pl-[22px]">
                {row.depth === 0 ? (
                  <SecondRow
                    row={row}
                    pullRequest={pullRequest}
                    isCompactViewport={isCompactViewport}
                    onOpenPullRequest={openPullRequest}
                    providerId={thread.providerId}
                    showProjectName={showProjectName}
                    showBranch={showBranch}
                    showEffort={showEffort}
                    execution={execution}
                  />
                ) : (
                  <ChildSecondRow
                    row={row}
                    providerId={thread.providerId}
                    showEffort={showEffort}
                    execution={execution}
                  />
                )}
              </div>
            ) : null}
          </div>
        </RowHover>
      </div>
    </RowContextMenu>
  );
}
