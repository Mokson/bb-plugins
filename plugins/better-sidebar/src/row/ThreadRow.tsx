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
import { ProviderGlyph } from "./ProviderGlyph";
import { relativeTimeLabel } from "./relative-time";
import { SecondRow } from "./SecondRow";
import { StatusGlyph } from "./StatusGlyph";

/** B9: one indent step per parent hop, in px so the truncation stays honest. */
const DEPTH_INDENT_PX = 12;

/**
 * B57.2, superseding B51.1: the chevron's box, drawn only on a parent row and
 * placed immediately after the title rather than in a reserved gutter. Nothing
 * is reserved on a childless row, so B57.5's alignment comes from removal.
 * `relative` is what the hit area's `-inset-1.5` measures against.
 */
const CHEVRON_BOX_CLASS =
  "relative flex size-3.5 shrink-0 items-center justify-center";

/**
 * The provider column: the glyph's own box (`size-3.5`), reserved even when
 * the mark is hidden so titles and row 2 keep one left edge across settings.
 * With row 1's `gap-2` it measures the 22px that row 2 is indented by.
 */
const PROVIDER_BOX_CLASS = "size-3.5 shrink-0";

/** B51.5: a fixed slot per trailing element, so the time column aligns down the list. */
const TRAILING_TEXT_CLASS =
  "shrink-0 text-right text-[11px] tabular-nums text-muted-foreground";

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
  /** B61.1: `false` skips `experimental_useSidebarThreadPullRequest` entirely. */
  showPrChip?: boolean;
  /** B59: the provider logo at the row's left edge. */
  showProviderGlyph?: boolean;
  /** B59: the row's own relative time, at the right edge. */
  showRelativeTime?: boolean;
  /** B61.2: `false` mounts no `IntersectionObserver` and sends no `rowSignals`. */
  showSignals?: boolean;
  /** The thread-list slot prop; the list owns it, the row only forwards it. */
  isCompactViewport: boolean;
  /** B47: called after every thread open, so the drawer closes and search clears. */
  onNavigate: () => void;
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
  showProviderGlyph = true,
  showRelativeTime = true,
  showSignals = true,
  isCompactViewport,
  onNavigate,
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
      <div data-better-sidebar-row={thread.id}>
        <RowHover
          row={row}
          isCompactViewport={isCompactViewport}
          // B54: bb's own row is 28px tall with `0 0 0 8px` padding and a 13px
          // text size. Row 1 carries the height itself, so a root row with no
          // second row measures exactly one bb row.
          className={cn(
            // B73.2: `pr-2` is gone. The container's right inset now ends the
            // row, so the trailing time and the section count share one edge.
            "relative w-full min-w-0 rounded-md text-left text-[13px]",
            "hover:bg-accent/60 focus-within:ring-1 focus-within:ring-ring",
          )}
          // B57.3: no base left inset — the provider glyph starts at the row's
          // left edge. The per-depth indent stays, because B9 needs a child to
          // read as sitting under its parent.
          style={{ paddingLeft: row.depth * DEPTH_INDENT_PX }}
        >
          <a
            href="#"
            // B44: both attributes, on the interactive element, in visual
            // order. Omitting either — or making it anything but an anchor —
            // silently breaks bb's nine sidebar shortcuts.
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            aria-label={row.title}
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
            {/* B57: one row-1 layout for every row —
                [provider] title [chevron, parents only] … [status] [time]. */}
            <div data-better-sidebar-row1="" className="flex h-7 min-w-0 items-center gap-2">
              {/* B51.2: leading, on every row. Its resolution is unchanged.
                  With the setting off the box stays and only the mark goes, so
                  every title keeps its x whichever way the setting is set. */}
              {showProviderGlyph ? (
                <ProviderGlyph providerId={thread.providerId} />
              ) : (
                <span aria-hidden className={PROVIDER_BOX_CLASS} />
              )}

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
                <span
                  className={cn(
                    // Revised B51.5 with B57.2: intrinsic rather than
                    // `flex-1`, so the chevron sits against the end of the
                    // title instead of being pushed to the row's edge. The
                    // trailing cluster keeps the right edge with `ml-auto`,
                    // and the title still truncates only when it runs out.
                    "min-w-0 truncate",
                    thread.isUnread ? "font-semibold" : "font-normal",
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
                      className="size-3"
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
              <div className="ml-auto flex shrink-0 items-center">
                {/* B61.2: at `compact` and `default` this is not mounted, so
                    no observer exists and no `rowSignals` request is sent. */}
                {showSignals ? <RowSignals threadId={thread.id} /> : null}
                <StatusGlyph thread={thread} />
                {/* B51.4: the row's own time, on every row, at the right edge.
                    With time hidden the trailing cluster is fully intrinsic —
                    B51.5's fixed slot has no anchor left to pin. */}
                {showRelativeTime ? (
                  <span className={cn(TRAILING_TEXT_CLASS, "ml-1.5 w-7")}>
                    {relativeTimeLabel(lastActivityAt ?? thread.updatedAt, now)}
                  </span>
                ) : null}
              </div>
            </div>

            {/* B52.1: a child renders row 1 only — its project and workspace
                repeat its parent's. Row 2 is indented to the provider column so
                the two lines share a left edge: 22px is the glyph box
                (`size-3.5`) plus row 1's `gap-2`. The box is drawn whether or
                not the mark is, so the indent is unconditional too. */}
            {showSecondRow && row.depth === 0 ? (
              <div className="pb-1 pl-[22px]">
                <SecondRow
                  row={row}
                  pullRequest={pullRequest}
                  isCompactViewport={isCompactViewport}
                  onOpenPullRequest={openPullRequest}
                />
              </div>
            ) : null}
          </div>
        </RowHover>
      </div>
    </RowContextMenu>
  );
}
