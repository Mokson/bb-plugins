import type {
  PluginSidebarPullRequest,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { GlyphName } from "../ui/Glyph";

/**
 * The row's action list, as data.
 *
 * Two menus render it: the right-click `RowContextMenu` (B46) and the dropdown
 * behind the hover cluster's "…" button. Radix gives those two roots different
 * `Item` components, so the only thing they can share is the description of
 * what the items ARE — which is also the only thing that must not drift
 * between them.
 */
export interface RowMenuItem {
  readonly id: string;
  readonly glyph: GlyphName;
  readonly label: string;
  readonly destructive?: boolean;
  /** A separator is drawn BEFORE this item. */
  readonly separatorBefore?: boolean;
  readonly onSelect: () => void;
}

/** The subset of `useSidebarThreadActions` the row's menus call. */
export interface RowMenuActions {
  setPinned: (threadId: string, pinned: boolean) => unknown;
  setRead: (threadId: string, read: boolean) => unknown;
  archive: (threadId: string) => unknown;
  requestDelete: (threadId: string) => unknown;
}

export function buildRowMenuItems({
  thread,
  pullRequest,
  actions,
  open,
  onOpenPullRequest,
  requestRename,
}: {
  thread: PluginSidebarThread;
  pullRequest: PluginSidebarPullRequest | null;
  actions: RowMenuActions;
  open: (split: boolean) => void;
  onOpenPullRequest: () => void;
  requestRename: () => void;
}): readonly RowMenuItem[] {
  const items: RowMenuItem[] = [
    { id: "open", glyph: "external-link", label: "Open", onSelect: () => open(false) },
    { id: "open-split", glyph: "split", label: "Open in split", onSelect: () => open(true) },
  ];
  if (pullRequest !== null) {
    items.push({
      id: "open-pr",
      glyph: "pull-request",
      label: "Open pull request",
      onSelect: onOpenPullRequest,
    });
  }
  items.push(
    {
      id: "pin",
      glyph: "pin",
      label: thread.isPinned ? "Unpin" : "Pin",
      separatorBefore: true,
      onSelect: () => void actions.setPinned(thread.id, !thread.isPinned),
    },
    {
      id: "read",
      // The check is the mark-read glyph everywhere: the menu item and the
      // hover cluster's button are one action and must read as one.
      glyph: thread.isUnread ? "check" : "eye-off",
      label: thread.isUnread ? "Mark read" : "Mark unread",
      onSelect: () => void actions.setRead(thread.id, thread.isUnread),
    },
    { id: "rename", glyph: "pencil", label: "Rename", onSelect: requestRename },
    {
      id: "archive",
      glyph: "archive",
      label: "Archive",
      separatorBefore: true,
      onSelect: () => void actions.archive(thread.id),
    },
    {
      id: "delete",
      glyph: "trash",
      label: "Delete…",
      destructive: true,
      onSelect: () => void actions.requestDelete(thread.id),
    },
  );
  return items;
}
