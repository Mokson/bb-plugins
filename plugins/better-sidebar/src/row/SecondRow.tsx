import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { Glyph } from "../ui/Glyph";
import type { RenderRow } from "../model/types";
import { PrChip } from "./PrChip";
import { ProviderGlyph } from "./ProviderGlyph";
import { relativeTimeLabel } from "./relative-time";

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
 * Row 2: `project · workspace · ⟨spacer⟩ · relative time · PR chip ·
 * provider glyph`.
 *
 * The provider glyph always closes the line (B17), so the right edge is fixed
 * across every row even on a thread with no branch and no pull request — the
 * eye tracks one column instead of a ragged one.
 */
export function SecondRow({
  row,
  now,
  pullRequest,
  isCompactViewport,
  onOpenPullRequest,
}: {
  row: RenderRow;
  /** Quantized clock, shared by every row in one render. */
  now: number;
  pullRequest: PluginSidebarPullRequest | null;
  isCompactViewport: boolean;
  onOpenPullRequest: () => void;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground",
        DIM_CLASS[row.dimLevel],
      )}
    >
      {row.projectName === null ? null : (
        <span className="truncate">{row.projectName}</span>
      )}

      {row.workspaceLabel === null ? null : (
        <span className="flex min-w-0 items-center gap-0.5">
          <Glyph name="git-branch" className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{row.workspaceLabel}</span>
        </span>
      )}

      <span className="flex-1" />

      {/* B12: the row's own `updatedAt`, so a recent child under an old
          parent reads as recent rather than inheriting the parent's age. */}
      <span className="shrink-0 tabular-nums">
        {relativeTimeLabel(row.thread.updatedAt, now)}
      </span>

      {pullRequest === null ? null : (
        <PrChip
          pullRequest={pullRequest}
          isCompactViewport={isCompactViewport}
          onOpen={onOpenPullRequest}
        />
      )}

      <ProviderGlyph providerId={row.thread.providerId} />
    </div>
  );
}
