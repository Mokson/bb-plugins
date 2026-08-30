import { useState, type SyntheticEvent } from "react";
import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { Glyph } from "../ui/Glyph";
import { HoverPopover } from "../ui/HoverPopover";

/**
 * B63, superseding B34. The chip is tinted by `state` — what this PR is —
 * rather than by `attention`, and in GitHub's own palette, because that is the
 * language the user already reads pull requests in everywhere else: draft
 * grey, open green, merged purple, closed red. `attention` keeps its full role
 * in words on the hover card (B63.2).
 */
const STATE_TONE: Record<PluginSidebarPullRequest["state"], string> = {
  draft: "text-muted-foreground",
  open: "text-emerald-600 dark:text-emerald-400",
  merged: "text-violet-600 dark:text-violet-400",
  closed: "text-red-700 dark:text-red-400",
};

/** B63.1: breakage overrides state, on an open PR only. */
const BREAKAGE_TONE = "text-red-700 dark:text-red-400";

function toneClass(pullRequest: PluginSidebarPullRequest): string {
  const isBroken =
    pullRequest.attention === "checks_failed" ||
    pullRequest.attention === "conflicts";
  if (pullRequest.state === "open" && isBroken) return BREAKAGE_TONE;
  return STATE_TONE[pullRequest.state];
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
        // The row's content sits above an `absolute inset-0` anchor and is
        // transparent to the pointer; the chip is one of the few children that
        // must take its own clicks (B36).
        "pointer-events-auto flex shrink-0 items-center gap-0.5 text-2xs tabular-nums",
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
