import type {
  PluginSidebarThread,
  PluginSidebarThreadIndicator,
} from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { Glyph, type GlyphName } from "../ui/Glyph";
import { ROW1_ICON } from "./row-metrics";

/**
 * The box every trailing glyph sits in, whatever its artwork measures.
 *
 * Fixed rather than intrinsic (B17): the status glyph and the provider glyph
 * are drawn at different sizes but must end their line at the same inset. A
 * shared box centres each one on the same axis, so right-aligning the boxes
 * lines the icons up instead of leaving them a pixel or two apart — and row 2
 * keeps its right edge even on a thread with no branch and no PR.
 */
export const TRAILING_GLYPH_BOX_CLASS =
  "flex shrink-0 items-center justify-center";

/**
 * B66, superseding B22: every state carries a hue, taken from bb's own status
 * palette (`.bb-refs/bb-sidebar/src/StatusSlot.tsx:96-118`) so one colour means
 * one thing here and in bb's list. Planning is the single addition — bb groups
 * it with working as sky, and our five-state vocabulary keeps the two apart, so
 * planning takes violet.
 *
 * Every class is a light/dark pair (B66.1), and colour stays on the glyph and
 * nowhere else (B66.3): no row background, no filled badge, no tinted title.
 *
 * Motion means "happening right now" (B66.4-B66.6). `runtime` is one
 * determinate operation, so its spinner turns; the other three working kinds
 * pulse; a plan, a goal, a draft and an unread result hold still. Both classes
 * are stock Tailwind, so the plugin adds no keyframe (B66.7).
 */
const TREATMENTS: Partial<
  Record<PluginSidebarThreadIndicator, { glyph: GlyphName; className: string }>
> = {
  "waiting-for-input": {
    glyph: "user-plus",
    className: "text-indigo-600 dark:text-indigo-300",
  },
  "unread-error": {
    glyph: "circle-x",
    className: "text-red-700 dark:text-red-300",
  },
  runtime: {
    // B74.1/B74.2: artwork only. The hue and `animate-spin` are B66's.
    glyph: "loader-circle",
    className: "text-sky-600 dark:text-sky-400 animate-spin",
  },
  workflow: {
    glyph: "workflow",
    className: "text-sky-600 dark:text-sky-400 animate-pulse",
  },
  "background-agent": {
    glyph: "terminal",
    className: "text-sky-600 dark:text-sky-400 animate-pulse",
  },
  "background-command": {
    glyph: "terminal",
    className: "text-sky-600 dark:text-sky-400 animate-pulse",
  },
  "plan-mode": {
    glyph: "list-todo",
    className: "text-violet-600 dark:text-violet-400",
  },
  goal: { glyph: "target", className: "text-violet-600 dark:text-violet-400" },
  draft: { glyph: "pencil", className: "text-amber-700 dark:text-amber-300" },
  "working-draft": {
    glyph: "pencil",
    className: "text-amber-700 dark:text-amber-300",
  },
  "unread-success": {
    glyph: "dot",
    className: "text-emerald-700 dark:text-emerald-300",
  },
  // "none" is absent on purpose: idle draws nothing, the same miss an
  // unrecognized future kind takes.
};

/**
 * B20/B66. The five-state glyph in the row's trailing cluster.
 *
 * A lookup rather than a `switch`, because B20 is the point: bb adds indicator
 * kinds over time and a value outside the union must draw nothing and throw
 * nothing rather than blanking the sidebar. An unknown key simply misses.
 *
 * Revised B51.5: a miss draws NOTHING — not an empty box. An idle row is the
 * common row, and reserving a glyph's width on it truncated titles for a
 * column that was empty almost everywhere. Only the time slot is fixed now.
 */
export function StatusGlyph({ thread }: { thread: PluginSidebarThread }) {
  const treatment = TREATMENTS[thread.indicator];
  if (treatment === undefined) return null;

  return (
    // No margin of its own: the glyph now sits centred in the row's leading
    // column, where an `ml-1.5` would push it off centre. The trailing
    // cluster's B57.4 spacing rule is carried by the elements still in it.
    <span className={cn(TRAILING_GLYPH_BOX_CLASS, ROW1_ICON)}>
      <Glyph
        name={treatment.glyph}
        role="img"
        aria-label={thread.indicatorLabel ?? thread.indicator}
        className={cn(ROW1_ICON, treatment.className)}
      />
    </span>
  );
}
