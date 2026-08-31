/**
 * The two icon sizes a row draws, one per line.
 *
 * Every mark on a line is the same size as every other mark on it, and each
 * size is set against that line's TEXT rather than against the other line:
 * a 14px glyph beside 13px text reads as an icon with a caption, and the same
 * glyph beside row 2's 10px text reads as a mark with a footnote. Sized to
 * the text, both lines read as one thing.
 *
 * They live here, and not beside any one of their call sites, because the
 * requirement is that the sites AGREE — a size written inline in five files
 * is five chances to drift.
 */

/** Row 1: title is `text-[13px]`. Status, chevron and the action buttons. */
export const ROW1_ICON = "size-3";

/** Row 2: labels are `text-2xs` (10px). Provider mark, branch, PR chip. */
export const ROW2_ICON = "size-2.5";
