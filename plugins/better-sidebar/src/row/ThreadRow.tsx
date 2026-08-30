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
 * B54.3: the row's own left inset, matching bb's own row (`0 0 0 8px`) and the
 * host's `px-2` "New thread" chrome above the list, so the two do not step.
 */
const ROW_INSET_PX = 8;

/**
 * B51.1: the chevron's gutter, reserved on every row whether or not it has
 * children, so every title at a given depth starts on one vertical line. It is
 * the same measure as the trailing glyph box, so both edges of the row are set
 * on one ruler.
 */
const CHEVRON_GUTTER_CLASS =
  "relative flex size-3.5 shrink-0 items-center justify-center";

/** B51.5: a fixed slot per trailing element, so the time column aligns down the list. */
const TRAILING_TEXT_CLASS =
  "shrink-0 text-right text-[11px] tabular-nums text-muted-foreground";

export interface ThreadRowProps {
  row: RenderRow;
  /** Quantized clock, shared by every row in one render. */
  now: number;
  /** B18/B19, decided by the list from the `secondRow` setting and the mode. */
  showSecondRow: boolean;
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
  // that gate is expressed without breaking the rules of hooks.
  return props.row.thread.environment === null ? (
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
  showSecondRow,
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
            "relative w-full min-w-0 rounded-md pr-2 text-left text-[13px]",
            "hover:bg-accent/60 focus-within:ring-1 focus-within:ring-ring",
          )}
          style={{ paddingLeft: ROW_INSET_PX + row.depth * DEPTH_INDENT_PX }}
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
            {/* B51: one row-1 layout for every row —
                [chevron gutter] [provider] title … [child count] [status] [time]. */}
            <div data-better-sidebar-row1="" className="flex h-7 min-w-0 items-center gap-2">
              <span className={CHEVRON_GUTTER_CLASS}>
                {row.childCount === 0 ? null : (
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
                )}
              </span>

              {/* B51.2: leading, on every row. Its resolution is unchanged. */}
              <ProviderGlyph providerId={thread.providerId} />

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
                    "min-w-0 flex-1 truncate",
                    thread.isUnread ? "font-semibold" : "font-normal",
                  )}
                >
                  {row.title}
                </span>
              )}

              {/* B51.3: the trailing cluster, in order, each element in a slot
                  of its own width. B55.2: it never wraps — the title truncates
                  into it instead. */}
              <div className="flex shrink-0 items-center gap-1.5">
                <RowSignals threadId={thread.id} />
                {/* B53.2: the child count belongs here, never before the title,
                    where a number reads as part of the title. */}
                <span className={cn(TRAILING_TEXT_CLASS, "w-4")}>
                  {row.childCount === 0 ? null : row.childCount}
                </span>
                <StatusGlyph thread={thread} />
                {/* B51.4: the row's own time, on every row, at the right edge. */}
                <span className={cn(TRAILING_TEXT_CLASS, "w-7")}>
                  {relativeTimeLabel(thread.updatedAt, now)}
                </span>
              </div>
            </div>

            {/* B52.1: a child renders row 1 only — its project and workspace
                repeat its parent's. Row 2 is indented to the provider column so
                the two lines share a left edge. */}
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
