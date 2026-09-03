import { Fragment, useRef, type ReactNode } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  type PluginSidebarPullRequest,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { usePortalScopeProps } from "../lib/portal-scope";
import { Glyph, type GlyphName } from "../ui/Glyph";
import { useCompletedActions } from "../completed-context";
import { buildRowMenuItems } from "./row-menu-items";
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
  title,
  pullRequest,
  isCompleted,
  onNavigate,
  onOpenPullRequest,
  renameEditor,
  children,
}: {
  thread: PluginSidebarThread;
  /** The model's resolved title — B13's chain, not the raw nullable field. */
  title: string;
  pullRequest: PluginSidebarPullRequest | null;
  /** B86: whether the user has filed this thread; the model resolved it. */
  isCompleted: boolean;
  onNavigate: () => void;
  /** B36's one handler, owned by the row: `openUrl` returns a boolean that a
   *  second call site would be free to discard, and this one did. */
  onOpenPullRequest: () => void;
  renameEditor: RenameEditor;
  children: ReactNode;
}) {
  const actions = useSidebarThreadActions();
  const { setCompleted } = useCompletedActions();
  const portalScope = usePortalScopeProps();
  // Set by the Rename item, drained by `onCloseAutoFocus`. See the comment on
  // `ContextMenu.Content` for why the editor cannot open from `onSelect`.
  const renameRequested = useRef(false);

  const open = (split: boolean) => {
    if (split) actions.open(thread.id, { split: true });
    else actions.open(thread.id);
    onNavigate();
  };

  const items = buildRowMenuItems({
    thread,
    pullRequest,
    actions,
    isCompleted,
    setCompleted,
    open,
    onOpenPullRequest,
    requestRename: () => {
      renameRequested.current = true;
    },
  });

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          {...portalScope}
          // An item that hands focus to something outside the menu cannot do
          // it from `onSelect`. Radix wraps `Content` in a FocusScope that
          // *traps* focus for as long as the content is mounted, and `onSelect`
          // runs while it still is: the editor's `autoFocus` input mounts in
          // the same commit, FocusScope's `focusin` listener sees focus leave
          // the scope and pulls it straight back onto the menu, and the
          // resulting blur commits an unchanged title — which the editor's own
          // no-op guard correctly treats as a cancel. Rename appeared to do
          // nothing at all.
          //
          // `onCloseAutoFocus` runs from the FocusScope's own teardown, after
          // the trap is gone, so the editor opened here keeps the focus it
          // takes. Preventing the default matters only on that path: the menu
          // has no reason to reclaim focus from the editor it just opened,
          // while every other item still wants the trigger to get focus back.
          onCloseAutoFocus={(event) => {
            if (!renameRequested.current) return;
            renameRequested.current = false;
            event.preventDefault();
            renameEditor.start(title);
          }}
          aria-label="Thread actions"
          className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {items.map((item) => (
            <Fragment key={item.id}>
              {item.separatorBefore ? <Separator /> : null}
              <Item
                glyph={item.glyph}
                destructive={item.destructive}
                onSelect={item.onSelect}
              >
                {item.label}
              </Item>
            </Fragment>
          ))}
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
