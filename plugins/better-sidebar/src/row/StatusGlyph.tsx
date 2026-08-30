import type {
  PluginSidebarThread,
  PluginSidebarThreadIndicator,
} from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { Glyph, type GlyphName } from "../ui/Glyph";

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
  "flex size-3.5 shrink-0 items-center justify-center";

/**
 * B22: colour carries Needs-you and error, and nothing else. "Working" is
 * distinguished by motion (`animate-pulse`), never by hue — a list where four
 * states each have a colour reads as noise, and the two that actually want the
 * user stop standing out.
 */
const TREATMENTS: Partial<
  Record<PluginSidebarThreadIndicator, { glyph: GlyphName; className: string }>
> = {
  "waiting-for-input": { glyph: "user-plus", className: "text-amber-500" },
  "unread-error": { glyph: "circle-x", className: "text-destructive" },
  runtime: {
    glyph: "spinner",
    className: "text-muted-foreground animate-pulse",
  },
  workflow: {
    glyph: "workflow",
    className: "text-muted-foreground animate-pulse",
  },
  "background-agent": {
    glyph: "terminal",
    className: "text-muted-foreground animate-pulse",
  },
  "background-command": {
    glyph: "terminal",
    className: "text-muted-foreground animate-pulse",
  },
  "plan-mode": { glyph: "list-todo", className: "text-muted-foreground" },
  goal: { glyph: "target", className: "text-muted-foreground" },
  draft: { glyph: "pencil", className: "text-muted-foreground" },
  "working-draft": { glyph: "pencil", className: "text-muted-foreground" },
  "unread-success": { glyph: "dot", className: "text-muted-foreground" },
  // "none" is absent on purpose: idle draws nothing, the same miss an
  // unrecognized future kind takes.
};

/**
 * B20-B22. The five-state glyph in the row's fixed trailing slot.
 *
 * A lookup rather than a `switch`, because B20 is the point: bb adds indicator
 * kinds over time and a value outside the union must draw nothing and throw
 * nothing rather than blanking the sidebar. An unknown key simply misses.
 */
export function StatusGlyph({ thread }: { thread: PluginSidebarThread }) {
  const treatment = TREATMENTS[thread.indicator];
  if (treatment === undefined) return <span className={TRAILING_GLYPH_BOX_CLASS} />;

  return (
    <span className={TRAILING_GLYPH_BOX_CLASS}>
      <Glyph
        name={treatment.glyph}
        role="img"
        aria-label={thread.indicatorLabel ?? thread.indicator}
        className={cn("size-3.5", treatment.className)}
      />
    </span>
  );
}
