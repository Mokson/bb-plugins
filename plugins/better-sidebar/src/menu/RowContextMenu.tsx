import type { ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  useBbNavigate,
  type PluginSidebarPullRequest,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { usePortalScopeProps } from "../lib/portal-scope";
import { Glyph, type GlyphName } from "../ui/Glyph";
import type { RenameEditor } from "./useRenameEditor";

/**
 * The row's right-click menu (B46).
 *
 * The SDK ships no menu component, so a replaced sidebar owns this surface.
 * Three things are load-bearing:
 *
 * - `onNavigate` is called after **both** open paths (B47). `actions.open`
 *   takes no callback, so without this the mobile drawer stays open and the
 *   host's search field stays active.
 * - `pullRequest` arrives as a prop from `ThreadRow`'s single
 *   `experimental_useSidebarThreadPullRequest` call; a second subscription
 *   here would double the per-row cost the design exists to avoid.
 * - Deletion is `requestDelete`, which opens bb's own confirmation. There is
 *   deliberately no silent `delete` path.
 */
export function RowContextMenu({
  thread,
  pullRequest,
  onNavigate,
  renameEditor,
  children,
}: {
  thread: PluginSidebarThread;
  pullRequest: PluginSidebarPullRequest | null;
  onNavigate: () => void;
  renameEditor: RenameEditor;
  children: ReactNode;
}) {
  const actions = useSidebarThreadActions();
  const navigate = useBbNavigate();
  const portalScope = usePortalScopeProps();

  const open = (split: boolean) => {
    if (split) actions.open(thread.id, { split: true });
    else actions.open(thread.id);
    onNavigate();
  };

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          {...portalScope}
          aria-label="Thread actions"
          className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <Item glyph="external-link" onSelect={() => open(false)}>
            Open
          </Item>
          <Item glyph="split" onSelect={() => open(true)}>
            Open in split
          </Item>
          {pullRequest === null ? null : (
            <Item
              glyph="pull-request"
              onSelect={() => navigate.openUrl(pullRequest.url)}
            >
              Open pull request
            </Item>
          )}
          <Separator />
          <Item
            glyph="pin"
            onSelect={() => void actions.setPinned(thread.id, !thread.isPinned)}
          >
            {thread.isPinned ? "Unpin" : "Pin"}
          </Item>
          <Item
            glyph={thread.isUnread ? "eye" : "eye-off"}
            onSelect={() => void actions.setRead(thread.id, thread.isUnread)}
          >
            {thread.isUnread ? "Mark read" : "Mark unread"}
          </Item>
          <Item
            glyph="pencil"
            onSelect={() => renameEditor.start(thread.title ?? "")}
          >
            Rename
          </Item>
          <Separator />
          <Item glyph="archive" onSelect={() => actions.archive(thread.id)}>
            Archive
          </Item>
          <Item
            glyph="trash"
            destructive
            onSelect={() => actions.requestDelete(thread.id)}
          >
            Delete…
          </Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function Item({
  children,
  glyph,
  destructive = false,
  onSelect,
}: {
  children: ReactNode;
  glyph: GlyphName;
  destructive?: boolean;
  onSelect: () => void;
}) {
  return (
    <ContextMenu.Item
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
        destructive && "text-destructive-text",
      )}
    >
      <Glyph name={glyph} aria-hidden="true" />
      {children}
    </ContextMenu.Item>
  );
}

function Separator() {
  return <ContextMenu.Separator className="my-1 h-px bg-border" />;
}
