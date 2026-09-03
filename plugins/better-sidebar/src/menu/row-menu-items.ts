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

/**
 * A row action fired without awaiting it. A rejection must not escape as an
 * unhandled rejection: the row carries no error UI for these, so the failure
 * is logged and the row keeps everything else it draws.
 */
export function fireAndForget(result: unknown, label: string): void {
  if (result instanceof Promise) {
    result.catch((error: unknown) => {
      console.warn(`better-sidebar: ${label} failed: ${String(error)}`);
    });
  }
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
  // bb's own order, read from its bundle: read state, then pin, then rename,
  // then a separator, then archive and delete. Ours leads with the open
  // actions bb reaches by clicking the row, which it has no items for.
  items.push(
    {
      id: "read",
      // `Mail` / `MailOpen`, as bb draws it. An eye said "seen", which is a
      // different claim from "read".
      glyph: thread.isUnread ? "mail" : "mail-open",
      label: thread.isUnread ? "Mark read" : "Mark unread",
      separatorBefore: true,
      onSelect: () =>
        fireAndForget(actions.setRead(thread.id, thread.isUnread), "mark read"),
    },
    {
      id: "pin",
      glyph: thread.isPinned ? "pin-off" : "pin",
      label: thread.isPinned ? "Unpin" : "Pin",
      onSelect: () =>
        fireAndForget(actions.setPinned(thread.id, !thread.isPinned), "pin"),
    },
    { id: "rename", glyph: "pencil", label: "Rename", onSelect: requestRename },
    {
      id: "archive",
      glyph: "archive",
      label: "Archive",
      separatorBefore: true,
      onSelect: () => fireAndForget(actions.archive(thread.id), "archive"),
    },
    {
      id: "delete",
      glyph: "trash",
      // bb writes it without an ellipsis, though it also confirms.
      label: "Delete",
      destructive: true,
      onSelect: () => fireAndForget(actions.requestDelete(thread.id), "delete"),
    },
  );
  return items;
}
