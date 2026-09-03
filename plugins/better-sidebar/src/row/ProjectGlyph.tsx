import type { CSSProperties } from "react";
import { cn } from "../lib/utils";

/**
 * The project mark on row 2, drawn through the Icons plugin's published
 * contract: a span names its owner with `data-ribbon-icons-project` and that
 * plugin's stylesheet answers with `--ribbon-icons-project-glyph` (a CSS mask)
 * and `--ribbon-icons-project-color` when someone picked an icon. Nothing is
 * fetched and nothing subscribes; the glyph arrives through the cascade.
 *
 * The fallback is this plugin's own folder glyph, read path-for-path off
 * `ui/Glyph.tsx` and encoded the same way the Icons plugin encodes its own
 * masks (solid `#000` stroke; a mask reads shape, the `background-color`
 * supplies the color). It serves when the plugin is not installed and when no
 * icon was chosen for the project, so the mark always draws something.
 */

/** The folder path in `ui/Glyph.tsx`, kept identical to it. */
const FOLDER_PATH =
  "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";

/** The fallback folder as a mask URL, encoded to survive `url()` and CSS. */
const FOLDER_MASK: string = (() => {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none'` +
    ` stroke='#000' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>` +
    `<path d='${FOLDER_PATH}'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/gu, "%27")}")`;
})();

function projectMaskStyle(): CSSProperties {
  const mask = `var(--ribbon-icons-project-glyph, ${FOLDER_MASK}) center / contain no-repeat`;
  return {
    backgroundColor: "var(--ribbon-icons-project-color, currentColor)",
    WebkitMask: mask,
    mask,
  };
}

/**
 * The project mark. `projectId` may be null (a thread with no project): the
 * span then carries no owner attribute, and the fallback folder always draws.
 */
export function ProjectGlyph({
  projectId,
  className,
}: {
  projectId: string | null;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      data-ribbon-icons-project={projectId ?? undefined}
      className={cn("inline-block flex-none", className)}
      style={projectMaskStyle()}
    />
  );
}
