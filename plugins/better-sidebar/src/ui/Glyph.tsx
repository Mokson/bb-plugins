import type { SVGProps } from "react";
import { cn } from "../lib/utils";

const PATHS = {
  pin: "M12 2 9 9l-5 1 5.5 4.5L8 21l4-3 4 3-1.5-6.5L20 10l-5-1-3-7Z",
  "chevron-right": "m9 18 6-6-6-6",
  "chevron-down": "m6 9 6 6 6-6",
  "circle-x": "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm-3-13 6 6m0-6-6 6",
  "circle-question":
    "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm-2.5-8.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.7v.3m0 3.2h.01",
  spinner: "M12 2v4m0 12v4m10-10h-4M6 12H2m15.5-6.5-2.8 2.8M9.3 14.7l-2.8 2.8m11-.1-2.8-2.8M9.3 9.3 6.5 6.5",
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
} as const;

export type GlyphName = keyof typeof PATHS;

/**
 * Shared inline-SVG glyph primitive. No icon library is installed, so every
 * glyph in this plugin is drawn from an inline path at a fixed `size-3.5` box
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
