import { useState, type SyntheticEvent } from "react";
import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { Glyph } from "../ui/Glyph";
import { HoverPopover } from "../ui/HoverPopover";

/**
 * B34. The chip is tinted by `attention` — bb's rolled-up "does this need
 * you" signal — not by `state`, with one exception: a merged PR reads as
 * merged whatever its attention says.
 */
function toneClass(pullRequest: PluginSidebarPullRequest): string {
  if (pullRequest.state === "merged") return "text-violet-500";
  switch (pullRequest.attention) {
    case "checks_failed":
    case "conflicts":
      return "text-destructive";
    case "ready_to_merge":
      return "text-emerald-500";
    default:
      return "text-muted-foreground";
  }
}

/** B35: the attention reason in words, not a status code. */
const ATTENTION_COPY: Record<PluginSidebarPullRequest["attention"], string> = {
  blocked: "Blocked",
  changes_requested: "Changes requested",
  checks_failed: "Checks failed",
  checks_pending: "Checks running",
  closed: "Closed",
  conflicts: "Conflicts",
  draft: "Draft",
  merged: "Merged",
  none: "No action needed",
  ready_to_merge: "Ready to merge",
  review_requested: "Review requested",
};

const STATE_COPY: Record<PluginSidebarPullRequest["state"], string> = {
  closed: "Closed",
  draft: "Draft",
  merged: "Merged",
  open: "Open",
};

/**
 * B33-B36. The pull-request chip on row 2, left of the provider glyph.
 *
 * Purely presentational: it calls no hook and mounts without a host.
 * `ThreadRow` makes the one `experimental_useSidebarThreadPullRequest` call
 * per row (§6) and hands the result to both this chip and the context menu,
 * so the row never pays for two subscriptions — and this file stays testable
 * on its own.
 */
export function PrChip({
  pullRequest,
  isCompactViewport,
  onOpen,
}: {
  pullRequest: PluginSidebarPullRequest;
  isCompactViewport: boolean;
  /** Invoked on activation; `ThreadRow` routes it to the host's `openUrl`. */
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);

  // B36: opening a PR must never navigate the thread underneath it. The row
  // is the click target for the whole line, so the chip stops the event here
  // rather than relying on the row to guess what was clicked.
  const activate = (event: SyntheticEvent) => {
    event.stopPropagation();
    event.preventDefault();
    onOpen();
  };

  const chip = (
    <span
      role="link"
      tabIndex={0}
      aria-label={`Pull request #${pullRequest.number}: ${pullRequest.title}`}
      data-better-sidebar-pr={pullRequest.number}
      className={cn(
        "flex shrink-0 items-center gap-0.5 text-2xs tabular-nums",
        toneClass(pullRequest),
      )}
      onClick={activate}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") activate(event);
      }}
      onPointerOver={() => setOpen(true)}
      onPointerOut={() => setOpen(false)}
    >
      <Glyph name="pull-request" className="size-3" aria-hidden />
      {`#${pullRequest.number}`}
    </span>
  );

  // B36: on a compact viewport the chip stays a plain tappable link. There is
  // no hover on a touch pointer, so a hover card would be dead weight at best
  // and a stuck overlay at worst.
  if (isCompactViewport) return chip;

  return (
    <HoverPopover open={open} onOpenChange={setOpen} trigger={chip} side="top">
      {/* B35: a rendered card, not a native `title` — a title cannot carry
          the state line, and its timing is the browser's, not ours. */}
      <div className="z-50 max-w-64 rounded-lg border border-border bg-popover p-2 text-popover-foreground shadow-md">
        <p className="text-xs font-medium">{pullRequest.title}</p>
        <p className="mt-1 text-2xs text-muted-foreground">
          {`#${pullRequest.number} · ${STATE_COPY[pullRequest.state]} · ${ATTENTION_COPY[pullRequest.attention]}`}
        </p>
      </div>
    </HoverPopover>
  );
}
