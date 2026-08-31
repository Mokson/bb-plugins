import type { SVGProps } from "react";
import { cn } from "../lib/utils";

const PATHS = {
  // bb's own menu draws lucide `Pin`/`PinOff`; this was a five-pointed STAR
  // under the name `pin`, which read as "favourite" rather than "pinned".
  pin:
    "M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1Z",
  "pin-off":
    "M12 17v5M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89M2 2l20 20M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11",
  // Read state is an envelope in bb, not an eye: the eye said "seen", which
  // is a different claim from "read".
  mail: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm18 3-10 6L2 7",
  "mail-open":
    "M21.2 8.4c.5.38.8.97.8 1.6v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V10a2 2 0 0 1 .8-1.6l8-6a2 2 0 0 1 2.4 0ZM22 10l-10 6-10-6",
  "chevron-right": "m9 18 6-6-6-6",
  "chevron-down": "m6 9 6 6 6-6",
  "circle-x": "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm-3-13 6 6m0-6-6 6",
  "circle-question":
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm-2.5-8.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7v.3m0 3.2h.01",
  // B74.1: an open arc, replacing the eight-spoke `spinner`. Eight spokes at
  // 45-degree intervals repeat every 45 degrees, so `animate-spin` drew an
  // identical frame eight times per revolution and read as a shimmer. An arc
  // has one visible start and one visible end, so the turn is legible at 14px.
  "loader-circle": "M21 12a9 9 0 1 1-6.219-8.56",
  dot: "M12 12m-4 0a4 4 0 1 0 8 0 4 4 0 1 0-8 0",
  "triangle-alert":
    "M12 2 1 21h22L12 2Zm0 7v5m0 3h.01",
  "circle-alert": "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-14v5m0 3h.01",
  pause: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM9.5 8v8m5-8v8",
  "pull-request":
    "M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12-6a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm-3 3v3a3 3 0 0 1-3 3H9",
  refresh:
    "M21 12a9 9 0 0 1-15.5 6.3M3 12a9 9 0 0 1 15.5-6.3M21 3v6h-6M3 21v-6h6",
  x: "M18 6 6 18M6 6l12 12",
  check: "M20 6 9 17l-5-5",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35",
  // Indicator glyphs for the five-state table (PRODUCT.md section 4).
  workflow: "M3 3h6v6H3zM15 15h6v6h-6zM9 6h4a2 2 0 0 1 2 2v7",
  "user-plus":
    "M11 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM3 21a8 8 0 0 1 13-6.2M17 18h6m-3-3v6",
  terminal: "m4 17 6-6-6-6M12 19h8",
  "list-todo":
    "M3 6l1.5 1.5L7 5M3 13l1.5 1.5L7 11M3 20l1.5 1.5L7 18M11 6h10M11 13h10M11 20h10",
  target:
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-4a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm0-4a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  pencil: "M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3Z",
  // Context-menu glyphs (PRODUCT.md B46).
  split: "M12 3v18M3 3h18v18H3z",
  archive: "M3 3h18v4H3zM5 7v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7M10 12h4",
  trash:
    "M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6M10 11v6M14 11v6",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  "eye-off":
    "M10.7 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.8 3.7M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6M2 2l20 20M9.9 9.9a3 3 0 0 0 4.2 4.2",
  "external-link":
    "M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
  // Row-2 workspace glyphs (PRODUCT.md B16).
  folder:
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  "git-branch":
    "M6 3v12m0 0a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm12-6a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm-3 3v1a5 5 0 0 1-5 5H9",
  monitor: "M3 4h18v12H3zM8 20h8m-4-4v4",
  // B76.1: the display-options trigger. Three tracks with a handle each, so
  // the button reads as "options for this view" rather than as a filter.
  sliders: "M4 6h9m4 0h3M4 12h3m4 0h10M4 18h9m4 0h3M13 4v4M7 10v4M13 16v4",
  // bb's own "New thread" mark, read path-for-path off the rendered nav item
  // above this list: a rounded speech bubble with a tail, plus a `+`. It is
  // not a lucide icon, so it cannot be named from that set.
  "new-thread":
    "M21.5 12C21.5 17.2467 17.2467 21.5 12 21.5C10.3719 21.5 8.8394 21.0904 7.5 20.3687C5.63177 19.362 4.37462 20.2979 3.26592 20.4658C3.09774 20.4913 2.93024 20.4302 2.80997 20.31C2.62741 20.1274 2.59266 19.8451 2.6935 19.6074C3.12865 18.5818 3.5282 16.6382 2.98341 15C2.6698 14.057 2.5 13.0483 2.5 12C2.5 6.75329 6.75329 2.5 12 2.5C17.2467 2.5 21.5 6.75329 21.5 12ZM15.5 12H8.5M12 8.5V15.5",
  // The hover cluster's overflow trigger (three dots, drawn as three dashes so
  // the stroke-only primitive can render them at 14px).
  "more-horizontal": "M5 12h.01M12 12h.01M19 12h.01",
} as const;

export type GlyphName = keyof typeof PATHS;

/**
 * Shared inline-SVG glyph primitive. No icon library is installed, so every
 * glyph in this plugin is drawn from an inline path. `size-3.5` is only the
 * default, for menus and other prose-sized surfaces; the row passes its
 * line's own size (`icon-sizes.ts`)
 * — an unrecognized `name` is impossible at the type level, so there is no
 * runtime fallback branch to test.
 */
export function Glyph({
  name,
  className,
  ...props
}: { name: GlyphName; className?: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-3.5", className)}
      {...props}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
