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
import { COLLISION_PADDING } from "../ui/overlay";
import { resolveTitle } from "../model/list-model";
import { ProviderGlyph } from "../row/ProviderGlyph";
import { StatusGlyph } from "../row/StatusGlyph";
import { relativeTimeLabel } from "../row/relative-time";
import { useNow } from "../useNow";
import { useThreadExecutions } from "./useThreadExecutions";
import { useThreadWorkStats } from "./useThreadWorkStats";
import type { ThreadExecution } from "../server-contract";
import { durationLabel } from "../row/relative-time";

/** B58.3: three marks read as a set; a fourth reads as a queue. */
const MAX_ICONS = 3;

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

function ChipBody({ threadId }: PluginThreadHeaderActionProps) {
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
  // B85: tokens and tools ride the same gate as the model lookup.
  const stats = useThreadWorkStats(
    children.map((child) => child.id),
    open && wantsMetadata,
  );

  // B58.2: most threads have no children, and an empty chip is chrome tax on
  // every header. Nothing at all, not a disabled control.
  if (children.length === 0) return null;

  const needsYou = children.some((child) => child.hasPendingInteraction === true);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-better-sidebar-children="chip"
          aria-label={`${children.length} child threads`}
          className={cn(
            // B58.5: 28px inside the header's 48px chrome row, and shrink-0 so
            // it never absorbs the row's collapse. B82: the surface matches
            // bb's own header buttons (the Commit pattern): 28px, rounded-md,
            // hairline `border-border/70`, no shadow, state-hover fill.
            "flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border/70 bg-transparent px-2",
            "text-xs text-muted-foreground shadow-none",
            "hover:bg-accent hover:text-foreground",
            open && "bg-accent text-foreground",
            needsYou && "text-amber-500",
          )}
        >
          <ProviderIconSet threads={children} />
          {/* B58.4→B81: the compact chip is icons plus a count, at every
              viewport — the count badge IS the label the phone used to keep. */}
          <span
            data-better-sidebar-children="count"
            className={cn(
              // B82: the muted gray pill the host's own count badges use.
              "shrink-0 rounded-full bg-muted px-1.5 text-2xs font-normal leading-4 tabular-nums text-muted-foreground",
              needsYou && "bg-amber-500/15 text-amber-500",
            )}
          >
            {children.length}
          </span>
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
          {/* B83: the list is the sidebar's row, not a cousin of it. Same
              two-line anatomy — status, title, trailing time; provider mark
              and model · effort below — same text sizes and the same muted
              metadata tone, so opening the popover reads as moving the
              sidebar's list beside the thread, not as a new component to
              learn. */}
          <ul className="flex min-h-0 flex-col gap-px overflow-y-auto p-1.5 pt-0.5">
            {children.map((child) => {
              const execution =
                executions.status === "ready"
                  ? (executions.executions.get(child.id) ?? null)
                  : null;
              const stat =
                stats.status === "ready" ? (stats.stats.get(child.id) ?? null) : null;
              return (
                <li key={child.id} className="list-none">
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      actions.open(child.id);
                    }}
                    // B86: the native tooltip carries the full title the row
                    // truncates - the same fallback the browser applies to
                    // any clipped label, no overlay of our own to maintain.
                    title={resolveTitle(child)}
                    className="flex w-full flex-col rounded-md px-1 py-0.5 text-left hover:bg-accent/60"
                  >
                    {/* Row 1 — [status] title … [time]. B87: no reserved
                        leading column — most children are idle, and a fixed
                        empty box indented every title away from the flush-left
                        metadata line beneath it. The glyph draws inline only
                        when the thread has a state, so idle rows read as one
                        clean left edge and working rows announce themselves
                        with the same sky motion the sidebar uses. */}
                    <span className="flex h-7 min-w-0 items-center gap-2">
                      <StatusGlyph thread={child} />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-normal">
                        {resolveTitle(child)}
                      </span>
                      {/* The sidebar's trailing slot: the same 11px muted
                          column, fed by the same clock. */}
                      <span className="w-7 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground/70">
                        {relativeTimeLabel(child.updatedAt, now)}
                      </span>
                    </span>
                    {/* Row 2 — the child line, with the work labels t3's list
                        carries and this plugin can expose: model · effort ·
                        duration · tokens · tools. B84: no left margin — the
                        sidebar's child second row starts at the row's left
                        edge, so this one does too. B71.3/B72.1: loading,
                        error and compact all render the row without this
                        line, and a missing stat contributes no segment. */}
                    {execution === null ? null : (
                      // B88: the sidebar's second row is pulled up 4px with
                      // `-mt-1` to close the gap row 1's fixed 28px box
                      // leaves under a 13px title; this line matches that
                      // rhythm, flush left per B84.
                      <span className="-mt-1 flex min-w-0 items-center gap-0.5 pb-1 text-2xs text-muted-foreground/70">
                        <ProviderGlyph providerId={child.providerId} size="small" />
                        <span className="min-w-0 truncate">
                          {metadataParts({
                            execution,
                            duration: durationOf(child, now),
                            tokens: stat?.tokens ?? null,
                            toolCalls: stat?.toolCalls ?? null,
                          }).join(" · ")}
                        </span>
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * B85. The metadata line's segments, in t3's order: model · effort ·
 * duration · tokens · tools. Each work label independently hideable - a null
 * contributes no segment at all, so B70.4's stray " · " cannot come back.
 *
 * Model and effort stay one segment (B84's one-fact rule), duration counts
 * created-to-done as B70.1 did, and the two work stats come from the batched
 * `threadWorkStats` lookup. Tokens use the 85.7k / 1.2m compaction, because
 * "170535372 tok" is not a label, it is a wall.
 */
function metadataParts({
  execution,
  duration,
  tokens,
  toolCalls,
}: {
  execution: ThreadExecution["execution"];
  duration: string | null;
  tokens: number | null;
  toolCalls: number | null;
}): string[] {
  const modelPart =
    execution === null
      ? null
      : execution.reasoningLevel
        ? `${execution.model} · ${execution.reasoningLevel}`
        : execution.model;
  return [
    modelPart,
    duration,
    tokens === null ? null : tokenLabel(tokens),
    // B85: zero hides. The timeline read is windowed (segmentLimit 100), so a
    // zero counts the latest window, not the thread - "0 tools" would assert
    // more than bb told us. A positive count can only under-count, never lie.
    toolCalls === null || toolCalls === 0 ? null : `${toolCalls} tools`,
  ].filter((part): part is string => typeof part === "string");
}

/** B85: 999 tok, then 85.7k tok, then 1.2m tok. */
function tokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m tok`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tok`;
  return `${tokens} tok`;
}

/**
 * B70.1, restored: elapsed created-to-done. `now - createdAt` while the
 * thread runs, `updatedAt - createdAt` once it stopped. It answers "how long
 * did this take", the question a dispatched-agent list exists to answer.
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
 * B81. The compact collapsed chip: one mark per vendor, then the count.
 *
 * B58.3 showed one glyph per child capped at three, which on a fan-out of five
 * Claude children drew the same mark three times and still needed a `+N`. The
 * chip's job on the header is to say what ran on and how much of it — a set of
 * distinct vendor marks plus a number says both in half the width. A repeated
 * mark carries no information a second time, so children dedupe by
 * `providerId` in first-appearance order and the distinct set caps at three;
 * past three the count badge already says the total, so nothing more is drawn.
 *
 * B75.1 carries over per-vendor: a vendor whose children include one of the
 * `RUNNING_INDICATORS` kinds draws the sky ring on its single mark. B75.3
 * still holds — no motion, and the ring is a box-shadow so the set's height
 * and the chip's 28px box never change.
 */
function ProviderIconSet({
  threads,
}: {
  threads: readonly PluginSidebarThread[];
}) {
  const byProvider = new Map<string, PluginSidebarThread[]>();
  for (const thread of threads) {
    const group = byProvider.get(thread.providerId);
    if (group) group.push(thread);
    else byProvider.set(thread.providerId, [thread]);
  }
  const shown = [...byProvider.values()].slice(0, MAX_ICONS);
  return (
    <span className="flex shrink-0 items-center">
      {shown.map((group, index) => {
        const isRunning = group.some((thread) =>
          RUNNING_INDICATORS.has(thread.indicator),
        );
        return (
          <span
            key={group[0].providerId}
            data-better-sidebar-children={isRunning ? "running" : undefined}
            className={cn(
              index > 0 && "-ml-1",
              isRunning && "rounded-full ring-1 ring-sky-500 dark:ring-sky-400",
            )}
          >
            <ProviderGlyph providerId={group[0].providerId} />
          </span>
        );
      })}
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
