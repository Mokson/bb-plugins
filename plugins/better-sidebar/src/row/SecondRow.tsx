import { Fragment, type ReactNode } from "react";
import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { Glyph } from "../ui/Glyph";
import type { RenderRow } from "../model/types";
import { PrChip } from "./PrChip";
import { ProviderGlyph } from "./ProviderGlyph";
import { ROW2_ICON } from "./row-metrics";

/**
 * B41, resolved against B14 by §7: the stale gradient lives on row 2 and the
 * section header only, never on the row-1 title, and it floors at
 * `opacity-70` so `OLDER` stays legible. `dimLevel: 0` emits no class at all,
 * so a row in a section the user is working in carries no opacity whatsoever.
 */
const DIM_CLASS: Record<RenderRow["dimLevel"], string> = {
  0: "",
  1: "opacity-90",
  2: "opacity-80",
  3: "opacity-70",
};

/**
 * Row 2: `project · workspace · PR chip`, on root rows only (B52).
 *
 * Time and the provider glyph both left this line for row 1 (B51.2, B51.4).
 * The line reads left to right, except for the PR chip: it is pinned to the
 * trailing edge so the numbers form one column down the list rather than
 * starting at a different x on every row, wherever that row's branch ended.
 */
export function SecondRow({
  row,
  pullRequest,
  isCompactViewport,
  onOpenPullRequest,
  providerId,
  showProjectName,
  showBranch,
  execution,
}: {
  row: RenderRow;
  pullRequest: PluginSidebarPullRequest | null;
  isCompactViewport: boolean;
  onOpenPullRequest: () => void;
  /** The provider whose mark rides on the model label; null draws none. */
  providerId: string | null;
  showProjectName: boolean;
  showBranch: boolean;
  /**
   * Model and effort, already gated by `showModel`. Null while the lookup is
   * in flight, when the thread never ran, and when the setting is off.
   */
  execution: { model: string; reasoningLevel: string } | null;
}) {
  /*
   * The labels as a LIST, so the separator can be interleaved rather than
   * baked onto each one. Written inline, a leading `·` survives whenever the
   * label before it is hidden — and every one of these is independently
   * hideable through settings or absent from the data.
   */
  const labels: { id: string; node: ReactNode }[] = [];

  // B56.2: `shrink-0` takes the project name out of the proportional shrink
  // that was starving it, and `max-w-[45%]` is the whole of its claim — it
  // renders in full inside that share and truncates only when it alone
  // exceeds it, never because the branch beside it is long.
  if (row.projectName !== null && showProjectName) {
    labels.push({
      id: "project",
      node: (
        <span
          data-better-sidebar-row2="project"
          className="flex max-w-[45%] shrink-0 items-center gap-0.5"
        >
          <Glyph name="folder" className={cn(ROW2_ICON, "shrink-0")} aria-hidden />
          <span className="truncate">{row.projectName}</span>
        </span>
      ),
    });
  }

  // B56.1: the only shrinkable child left, so it absorbs the whole deficit.
  // It is the longest label, the most repetitive down the list and the least
  // identifying, so its tail is the right thing to lose.
  if (row.workspaceLabel !== null && showBranch) {
    labels.push({
      id: "branch",
      node: (
        <span
          data-better-sidebar-row2="branch"
          className="flex min-w-0 shrink items-center gap-0.5"
        >
          <Glyph
            name="git-branch"
            className={cn(ROW2_ICON, "shrink-0")}
            aria-hidden
          />
          <span className="truncate">{row.workspaceLabel}</span>
        </span>
      ),
    });
  }

  // After the branch and before the chip. `shrink-0` keeps B56.1 intact: the
  // branch stays the ONE shrinkable child, so it absorbs the whole deficit
  // rather than the two of them splitting it.
  if (execution !== null) {
    // Model and effort stay ONE label. Splitting them put the separator
    // element between two spans, and with the spacing carried by `gap` the
    // line's accessible text collapsed to `claude-opus-5low`. The pair reads
    // as one fact anyway, and its own `·` is the pattern the rest follows.
    labels.push({
      id: "model",
      node: (
        <span
          data-better-sidebar-row2="model"
          className="flex shrink-0 items-center gap-0.5"
        >
          {/* The mark belongs to the model, not to the line: it says which
              agent ran this, which is the same fact the model names. It also
              means one setting governs both. */}
          {providerId === null ? null : (
            <ProviderGlyph providerId={providerId} size="small" monochrome />
          )}
          <span className="truncate">
            {execution.model} · {execution.reasoningLevel}
          </span>
        </span>
      ),
    });
  }

  return (
    <div
      className={cn(
        // `gap-1` rather than `gap-1.5`: the separator now carries the
        // division, so the whitespace only has to keep it off its neighbours.
        "flex min-w-0 items-center gap-1 text-2xs text-muted-foreground/70",
        DIM_CLASS[row.dimLevel],
      )}
    >
      {labels.map((label, index) => (
        <Fragment key={label.id}>
          {index === 0 ? null : <Separator />}
          {label.node}
        </Fragment>
      ))}

      {pullRequest === null ? null : (
        <span className="ml-auto shrink-0">
          <PrChip
            pullRequest={pullRequest}
            isCompactViewport={isCompactViewport}
            onOpen={onOpenPullRequest}
          />
        </span>
      )}
    </div>
  );
}

/**
 * The one divider row 2 uses, between every pair of labels it draws.
 *
 * `aria-hidden` because it is punctuation: a screen reader announcing "middle
 * dot" between a project and a branch reads worse than the pause it stands
 * for. Dimmer than the labels, so the eye groups on the words rather than on
 * the marks between them, and `shrink-0` so a squeezed line loses branch
 * characters rather than its own structure.
 */
function Separator() {
  return (
    <span aria-hidden className="shrink-0 text-muted-foreground/40">
      ·
    </span>
  );
}

/**
 * Row 2 for a CHILD row.
 *
 * B52.1 gave a child no second line because its project and branch only
 * repeat its parent's. Model and effort do not: a parent spawns subagents on
 * whatever model it picked for each, and that is the one fact about a child
 * the parent's own row cannot tell you. So the line exists again, carrying
 * different content rather than the same content indented.
 *
 * It is also where the provider mark lives on a child, which is why this
 * component exists at all — the mark moved to row 2, and a child had no row 2
 * to put it on.
 */
export function ChildSecondRow({
  row,
  providerId,
  execution,
}: {
  row: RenderRow;
  /** The provider whose mark rides on the model label; null draws none. */
  providerId: string | null;
  /** null while the lookup is in flight, and when the thread never ran. */
  execution: { model: string; reasoningLevel: string } | null;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1 text-2xs text-muted-foreground/70",
        DIM_CLASS[row.dimLevel],
      )}
    >
      {/* B71.3, revised: the mark belongs to the model, so an unresolved
          execution now drops both rather than leaving a mark with nothing to
          qualify. A placeholder for a model nobody chose is still never
          drawn. */}
      {execution === null ? null : (
        <>
          {providerId === null ? null : (
            <ProviderGlyph providerId={providerId} size="small" monochrome />
          )}
          <span className="min-w-0 truncate">
            {execution.model} · {execution.reasoningLevel}
          </span>
        </>
      )}
    </div>
  );
}
