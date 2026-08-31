import { Component, useState, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  useSettings,
  type PluginSidebarThread,
  type PluginSidebarThreadIndicator,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { parseSettings } from "../settings";
import { usePortalScopeProps } from "../lib/portal-scope";
import { COLLISION_PADDING } from "../DisplayMenu";
import { resolveTitle } from "../model/list-model";
import { ProviderGlyph } from "../row/ProviderGlyph";
import { StatusGlyph } from "../row/StatusGlyph";
import { durationLabel } from "../row/relative-time";
import { useNow } from "../useNow";
import { useThreadExecutions } from "./useThreadExecutions";
import type { ThreadExecution } from "../server-contract";

/** B58.3: three glyphs read as a cluster; a fourth reads as a queue. */
const MAX_GLYPHS = 3;

/**
 * B70.1. "Running" is read off `thread.indicator`, the one field `StatusGlyph`
 * already reads the row's state from — no second definition of running lives
 * in this plugin. These are the four kinds `StatusGlyph` draws in motion:
 * work is happening right now, so the clock is still counting.
 */
const RUNNING_INDICATORS: ReadonlySet<PluginSidebarThreadIndicator> = new Set([
  "runtime",
  "workflow",
  "background-agent",
  "background-command",
]);

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
  const { density } = parseSettings(useSettings().values);
  const now = useNow();

  const children = childrenOf(threads, threadId);
  // B72.1: `compact` promises no backend RPC of any kind (B60.1), and this is
  // the chip's first RPC. Open counts as enabled at every other density.
  const wantsMetadata = density !== "compact";
  const executions = useThreadExecutions(
    children.map((child) => child.id),
    open && wantsMetadata,
  );

  // B58.2: most threads have no children, and an empty chip is chrome tax on
  // every header. Nothing at all, not a disabled control.
  if (children.length === 0) return null;

  const needsYou = children.some((child) => child.hasPendingInteraction === true);
  // B75.2: N counts the running children, not all of them. "2 working" on a
  // chip of five says the thing the user opened the header to learn.
  const runningCount = children.filter((child) =>
    RUNNING_INDICATORS.has(child.indicator),
  ).length;
  // B75.4: attention outranks working. A chip with both reads "Needs you" and
  // stays amber; the rings still draw, because they mark different children.
  const label = needsYou
    ? "Needs you"
    : runningCount > 0
      ? `${runningCount} working`
      : `${children.length} children`;

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
          collisionPadding={COLLISION_PADDING}
          aria-label="Child threads"
          className="z-50 flex w-80 flex-col overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
          // A parent with seventeen subagents overflowed the viewport and the
          // card simply clipped: `overflow-hidden` is what rounds the corners,
          // and nothing under it could scroll. Radix measures the room its
          // side actually has and publishes it here, so the cap follows the
          // window instead of guessing a row count.
          style={{
            maxHeight: "var(--radix-popover-content-available-height)",
          }}
          {...portalScopeProps}
        >
          {/* `shrink-0`, so the count stays put while the list below scrolls
              rather than being the first thing squeezed out of view. */}
          <div className="flex shrink-0 items-center gap-2 px-3 pb-1 pt-2.5">
            <span className="text-xs font-semibold">Children</span>
            <span className="ml-auto text-2xs text-muted-foreground">
              {children.length}
            </span>
          </div>
          {/* `min-h-0` is what lets a flex child shrink below its content and
              hand the overflow to its own scrollbar. */}
          <ul className="flex min-h-0 flex-col gap-px overflow-y-auto p-1.5 pt-0.5">
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
                    {/* B71.3/B72.1: loading, error and compact all render the
                        row without this line. Never a spinner — arriving
                        metadata must not move the row it lands in. */}
                    {executions.status === "ready" ? (
                      <MetadataLine
                        thread={child}
                        execution={executions.executions.get(child.id) ?? null}
                        now={now}
                      />
                    ) : null}
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
 * B70. The child row's second line: `<model> · <effort> · <duration>`, plus
 * `fork` when the child is one.
 *
 * B70.4 is why this builds a filtered array and joins it. Conditional JSX with
 * hand-placed separators is what produces a stray " · · " on the thread that
 * never resolved its execution options, and that thread is common.
 *
 * B70.2 renders the model id and the effort verbatim. The line is a flex child
 * with `truncate` in a 320px popover, the same treatment the title above it
 * gets, so no shortener is invented here.
 */
function MetadataLine({
  thread,
  execution,
  now,
}: {
  thread: PluginSidebarThread;
  execution: ThreadExecution["execution"];
  now: number;
}) {
  const parts = [
    execution?.model,
    execution?.reasoningLevel,
    durationOf(thread, now),
    // B70.3: a fork is worth naming and a plain thread is not, so the null
    // origin contributes no segment at all. "thread" never renders.
    thread.originKind === "fork" ? "fork" : null,
  ].filter((part): part is string => typeof part === "string" && part !== "");

  if (parts.length === 0) return null;

  return (
    <span className="truncate text-2xs text-muted-foreground">
      {parts.join(" · ")}
    </span>
  );
}

/**
 * B70.1. Elapsed since creation: `now - createdAt` while the thread runs, and
 * `updatedAt - createdAt` once it stopped.
 *
 * It answers "how long did this take", which is the question when scanning
 * seats you dispatched. It is deliberately not time-since-activity — sidebar
 * row 1 already carries that, and repeating it here would spend the row.
 */
function durationOf(thread: PluginSidebarThread, now: number): string | null {
  const { createdAt, updatedAt } = thread;
  if (!Number.isFinite(createdAt)) return null;
  const end = RUNNING_INDICATORS.has(thread.indicator)
    ? now
    : Number.isFinite(updatedAt)
      ? updatedAt
      : null;
  return end === null ? null : durationLabel(end - createdAt);
}

/**
 * B58.3. Up to three overlapped provider glyphs, then a `+N` marker.
 *
 * The marker is a count rather than a fourth glyph: a fourth mark would read as
 * a fourth specific child, and the number is the thing the user wants.
 *
 * B75.1 adds the running mark: a thin sky ring on the glyph of a child whose
 * `indicator` is in `RUNNING_INDICATORS` — the same four kinds the sidebar row
 * draws sky, read off the same field, so working means one thing in both
 * places.
 *
 * B75.3 keeps it still. The sidebar row animates its working glyph because the
 * user is looking at the row; this chip sits in the header above the thread
 * they are reading, and motion there competes with that thread.
 *
 * B75.6: `ring` is a box-shadow, so it adds no layout size. The cluster's
 * height and the chip's 28px box are the same ringed or not.
 */
function GlyphCluster({ threads }: { threads: readonly PluginSidebarThread[] }) {
  const shown = threads.slice(0, MAX_GLYPHS);
  const overflow = threads.length - shown.length;
  return (
    <span className="flex shrink-0 items-center">
      {shown.map((thread, index) => {
        const isRunning = RUNNING_INDICATORS.has(thread.indicator);
        return (
          <span
            key={thread.id}
            data-better-sidebar-children={isRunning ? "running" : undefined}
            className={cn(
              index > 0 && "-ml-1",
              isRunning && "rounded-full ring-1 ring-sky-500 dark:ring-sky-400",
            )}
          >
            <ProviderGlyph providerId={thread.providerId} />
          </span>
        );
      })}
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
