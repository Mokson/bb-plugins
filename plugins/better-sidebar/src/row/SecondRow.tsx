import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { Glyph } from "../ui/Glyph";
import type { RenderRow } from "../model/types";
import { PrChip } from "./PrChip";

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
 * The provider glyph closed row 2 under B17 to pin its right edge across rows
 * with no branch and no PR; children have no row 2 to pin any more, so the
 * line simply reads left to right and ends where its content ends.
 */
export function SecondRow({
  row,
  pullRequest,
  isCompactViewport,
  onOpenPullRequest,
}: {
  row: RenderRow;
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

      {pullRequest === null ? null : (
        <PrChip
          pullRequest={pullRequest}
          isCompactViewport={isCompactViewport}
          onOpen={onOpenPullRequest}
        />
      )}
    </div>
  );
}
