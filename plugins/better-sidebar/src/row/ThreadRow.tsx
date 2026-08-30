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
      pullRequest={pullRequest}
      onNavigate={onNavigate}
      renameEditor={renameEditor}
    >
      {/* `RowHover` sits inside the row element rather than around it. Both
          seams mount a Radix `asChild` trigger, and such a trigger needs a real
          DOM element to clone: nesting one Radix root inside another's trigger
          silently drops the outer one's handlers. The row element takes the
          context menu and the host contract; the hover card takes the content
          inside it. */}
      <div
        role="button"
        tabIndex={0}
        // B44: both attributes, on the interactive element, in visual order.
        // Omitting either silently breaks bb's nine sidebar shortcuts.
        data-sidebar-thread-shortcut-target=""
        data-sidebar-thread-id={thread.id}
        aria-label={row.title}
        className={cn(
          "w-full min-w-0 rounded-md px-2 py-1.5 text-left",
          "hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
        style={{ paddingLeft: 8 + row.depth * DEPTH_INDENT_PX }}
        onClick={openThread}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") openThread();
        }}
        // B45: the host owns every rule of the split gesture; the row's only
        // job is to spread the props onto the same element it made clickable.
        {...splitProps}
      >
        <RowHover threadId={thread.id}>
          <div className="flex min-w-0 flex-col gap-0.5">
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
                  className="flex shrink-0 items-center gap-0.5 text-2xs tabular-nums text-muted-foreground"
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
                  className="min-w-0 flex-1 rounded-sm border border-border bg-background px-1 text-xs"
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
