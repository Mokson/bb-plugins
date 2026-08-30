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
import { SecondRow } from "./SecondRow";
import { StatusGlyph } from "./StatusGlyph";

/** B9: one indent step per parent hop, in px so the truncation stays honest. */
const DEPTH_INDENT_PX = 12;

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
          className={cn(
            "relative w-full min-w-0 rounded-md px-2 py-1.5 text-left",
            "hover:bg-accent/60 focus-within:ring-1 focus-within:ring-ring",
          )}
          style={{ paddingLeft: 8 + row.depth * DEPTH_INDENT_PX }}
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
          <div className="pointer-events-none relative flex min-w-0 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-1">
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
                  className="pointer-events-auto flex shrink-0 items-center gap-0.5 text-2xs tabular-nums text-muted-foreground"
                  onClick={toggleSubtree}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <Glyph
                    name={isSubtreeCollapsed ? "chevron-right" : "chevron-down"}
                    className="size-3"
                    aria-hidden
                  />
                  {row.childCount}
                </span>
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
                    "min-w-0 flex-1 truncate text-xs",
                    thread.isUnread ? "font-semibold" : "font-normal",
                  )}
                >
                  {row.title}
                </span>
              )}

              <RowSignals threadId={thread.id} />
              <StatusGlyph thread={thread} />
            </div>

            {showSecondRow ? (
              <SecondRow
                row={row}
                now={now}
                pullRequest={pullRequest}
                isCompactViewport={isCompactViewport}
                onOpenPullRequest={openPullRequest}
              />
            ) : null}
          </div>
        </RowHover>
      </div>
    </RowContextMenu>
  );
}
