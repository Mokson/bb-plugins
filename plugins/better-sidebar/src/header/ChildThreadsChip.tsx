import { Component, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  useSettings,
  type PluginSidebarThread,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { parseSettings } from "../settings";
import { usePortalScopeProps } from "../lib/portal-scope";
import { resolveTitle } from "../model/list-model";
import { ProviderGlyph } from "../row/ProviderGlyph";
import { StatusGlyph } from "../row/StatusGlyph";

/** B58.3: three glyphs read as a cluster; a fourth reads as a queue. */
const MAX_GLYPHS = 3;

/**
 * B58 — the child-threads chip in bb's thread header.
 *
 * These are bb CHILD THREADS: forks, side chats, and plugin-spawned threads.
 * bb's in-turn subagents are activity counters on the parent
 * (`activity.backgroundAgents`), not threads, so the label says "children" and
 * never "subagents".
 *
 * Our sidebar already nests children under their parents, so unlike t3's chip
 * this one is not rescuing hidden data. It earns the header because the header
 * survives a collapsed sidebar and an off-screen phone drawer, and because a
 * child that needs you is worth surfacing on the parent you are reading.
 */
export function ChildThreadsChip(props: PluginThreadHeaderActionProps) {
  // B59: `showHeaderChip: false` returns before `ChipBody` mounts, so the
  // thread-list subscription the chip reads is never opened either.
  const { showHeaderChip } = parseSettings(useSettings().values);
  if (!showHeaderChip) return null;
  return (
    <ChipBoundary>
      <ChipBody {...props} />
    </ChipBoundary>
  );
}

/**
 * B58.10. The host contains a throw to this one action, but a chip that blanks
 * the action row is still a chip that broke the header. Unexpected thread data
 * degrades to rendering nothing.
 */
class ChipBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function ChipBody({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  const { threads } = useSidebarThreads();
  const actions = useSidebarThreadActions();
  // B58.9: a split layout mounts one header per pane, so open state lives here
  // and never in module scope — otherwise opening one pane's chip opens all.
  const [open, setOpen] = useState(false);
  // Above the B58.2 early return: hook order may not depend on child count.
  const portalScopeProps = usePortalScopeProps();

  const children = childrenOf(threads, threadId);
  // B58.2: most threads have no children, and an empty chip is chrome tax on
  // every header. Nothing at all, not a disabled control.
  if (children.length === 0) return null;

  const needsYou = children.some((child) => child.hasPendingInteraction === true);
  const label = needsYou ? "Needs you" : `${children.length} children`;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-better-sidebar-children="chip"
          aria-label={`${children.length} child threads`}
          className={cn(
            // B58.5: 28px inside the header's 48px chrome row, and shrink-0 so
            // it never absorbs the row's collapse.
            "flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-border px-2",
            "text-2xs text-muted-foreground",
            "hover:bg-accent hover:text-foreground",
            open && "bg-accent text-foreground",
            needsYou && "text-amber-500",
          )}
        >
          <GlyphCluster threads={children} />
          {/* B58.4: the phone keeps the cluster and drops the words. */}
          {isCompactViewport ? null : <span className="truncate">{label}</span>}
        </button>
      </Popover.Trigger>
      {/* B58.8: portalled and portal-scoped, the seam every overlay in this
          plugin uses — not t3's absolute div plus a `fixed inset-0` click-away,
          which the host's own outside-click handling already contends with. */}
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="end"
          sideOffset={6}
          aria-label="Child threads"
          className="z-50 w-80 overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
          {...portalScopeProps}
        >
          <div className="flex items-center gap-2 px-3 pb-1 pt-2.5">
            <span className="text-xs font-semibold">Children</span>
            <span className="ml-auto text-2xs text-muted-foreground">
              {children.length}
            </span>
          </div>
          <ul className="flex flex-col gap-px p-1.5 pt-0.5">
            {children.map((child) => (
              <li key={child.id} className="list-none">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    actions.open(child.id);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                >
                  {/* B58.7: this plugin's own marks, so the five states a user
                      learned in the sidebar mean the same thing here. */}
                  <ProviderGlyph providerId={child.providerId} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-xs">
                      {resolveTitle(child)}
                    </span>
                    <span className="truncate text-2xs text-muted-foreground">
                      {child.originKind ?? "thread"}
                    </span>
                  </span>
                  <StatusGlyph thread={child} />
                </button>
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * B58.3. Up to three overlapped provider glyphs, then a `+N` marker.
 *
 * The marker is a count rather than a fourth glyph: a fourth mark would read as
 * a fourth specific child, and the number is the thing the user wants.
 */
function GlyphCluster({ threads }: { threads: readonly PluginSidebarThread[] }) {
  const shown = threads.slice(0, MAX_GLYPHS);
  const overflow = threads.length - shown.length;
  return (
    <span className="flex shrink-0 items-center">
      {shown.map((thread, index) => (
        <span key={thread.id} className={cn(index > 0 && "-ml-1")}>
          <ProviderGlyph providerId={thread.providerId} />
        </span>
      ))}
      {overflow > 0 ? (
        <span
          data-better-sidebar-children="overflow"
          className="ml-0.5 tabular-nums"
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

/**
 * B58.10. `threads` crosses the host boundary, so this treats a non-array and a
 * malformed entry as "no children" rather than trusting the declared type.
 */
function childrenOf(
  threads: readonly PluginSidebarThread[],
  threadId: string,
): PluginSidebarThread[] {
  if (!Array.isArray(threads)) return [];
  return threads.filter(
    (thread): thread is PluginSidebarThread =>
      thread !== null &&
      typeof thread === "object" &&
      typeof thread.id === "string" &&
      thread.parentThreadId === threadId,
  );
}
