import { Fragment, useRef, type ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginSidebarPullRequest,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { usePortalScopeProps } from "../lib/portal-scope";
import { Glyph, type GlyphName } from "../ui/Glyph";
import { buildRowMenuItems } from "../menu/row-menu-items";
import { ROW1_ICON } from "./icon-sizes";
import { useRowHoverSuppression } from "../dossier/RowHover";
import type { RenameEditor } from "../menu/useRenameEditor";

/**
 * The row's hover cluster: mark read, archive, and the overflow menu.
 *
 * bb's own sidebar reveals its row actions in place of the trailing indicator
 * rather than beside it (`.bb-sidebar-hover-actions` in the host's CSS), so a
 * row never changes width on hover and a title never re-truncates under the
 * pointer. This reproduces that with Tailwind's `group-hover`, because the
 * host's class names are private to it and carry no compatibility promise.
 *
 * Every button opts back into pointer events: the row's content sits above an
 * `absolute inset-0` anchor and is `pointer-events-none` so that a click
 * anywhere reaches it. `stopPropagation` on each click is what keeps the
 * button from also opening the thread.
 */
export function RowActions({
  thread,
  title,
  pullRequest,
  onNavigate,
  onOpenPullRequest,
  renameEditor,
  onOpen,
}: {
  thread: PluginSidebarThread;
  /** The model's resolved title (B13), the same one the menu renames from. */
  title: string;
  pullRequest: PluginSidebarPullRequest | null;
  onNavigate: () => void;
  onOpenPullRequest: () => void;
  renameEditor: RenameEditor;
  /** Opens the thread, shared with the row's anchor. */
  onOpen: (split: boolean) => void;
}) {
  const actions = useSidebarThreadActions();
  const portalScope = usePortalScopeProps();
  const suppressHoverCard = useRowHoverSuppression();
  const renameRequested = useRef(false);

  const items = buildRowMenuItems({
    thread,
    pullRequest,
    actions,
    open: (split) => {
      onOpen(split);
      onNavigate();
    },
    onOpenPullRequest,
    requestRename: () => {
      renameRequested.current = true;
    },
  });

  return (
    <span
      data-better-sidebar-row-actions={thread.id}
      // The dossier must not open over the buttons the pointer is aiming at.
      onPointerEnter={() => suppressHoverCard(true)}
      onPointerLeave={() => suppressHoverCard(false)}
      className={cn(
        // IN FLOW, as row 1's last child, taking the place the trailing
        // indicator gives up. Absolutely positioned it overlapped long
        // titles, and the inset that fixed the overlap double-counted the
        // faded indicator's width — so titles truncated with room to spare.
        // A flex sibling needs no magic width at all: the title's `truncate`
        // measures whatever is actually beside it.
        "pointer-events-auto ml-auto shrink-0 items-center gap-0.5",
        // Focus-within keeps the cluster reachable by keyboard, which hover
        // alone would strand.
        "hidden focus-within:flex group-hover/row:flex",
        "group-focus-within/row:flex group-has-[[data-state=open]]/row:flex",
      )}
    >
      <ActionButton
        label={thread.isUnread ? "Mark read" : "Mark unread"}
        glyph={thread.isUnread ? "check" : "eye-off"}
        onClick={() => void actions.setRead(thread.id, thread.isUnread)}
      />
      <ActionButton
        label="Archive"
        glyph="archive"
        onClick={() => void actions.archive(thread.id)}
      />
      <DropdownMenu.Root
        onOpenChange={(open) => {
          // An open menu pins the cluster visible; it must also outlive the
          // pointer leaving the row, which is what suppressing the card does.
          if (open) suppressHoverCard(true);
        }}
      >
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Thread actions"
            className={ACTION_BUTTON_CLASS}
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <Glyph name="more-horizontal" className={ROW1_ICON} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            {...portalScope}
            align="end"
            // Same reason as `RowContextMenu`: the rename editor cannot take
            // focus while the menu's FocusScope is still mounted.
            onCloseAutoFocus={(event) => {
              suppressHoverCard(false);
              if (!renameRequested.current) return;
              renameRequested.current = false;
              event.preventDefault();
              renameEditor.start(title);
            }}
            className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
          >
            {items.map((item) => (
              <Fragment key={item.id}>
                {item.separatorBefore ? (
                  <DropdownMenu.Separator className="my-1 h-px bg-border" />
                ) : null}
                <DropdownMenu.Item
                  onSelect={item.onSelect}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
                    "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
                    item.destructive && "text-destructive-text",
                  )}
                >
                  <Glyph name={item.glyph} aria-hidden="true" />
                  {item.label}
                </DropdownMenu.Item>
              </Fragment>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </span>
  );
}

const ACTION_BUTTON_CLASS = cn(
  "flex size-5 shrink-0 cursor-pointer items-center justify-center rounded",
  "text-muted-foreground outline-none",
  "hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
);

function ActionButton({
  label,
  glyph,
  onClick,
}: {
  label: string;
  glyph: GlyphName;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={ACTION_BUTTON_CLASS}
      // Both, and on every button: the anchor beneath reacts to the click and
      // the list's drag gesture reacts to the pointer-down.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      }}
    >
      <Glyph name={glyph} className={ROW1_ICON} aria-hidden="true" />
    </button>
  );
}
