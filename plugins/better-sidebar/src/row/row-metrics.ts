/**
 * The sizes and columns a row draws, and the header above it must match.
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

/**
 * The 22px leading gutter, drawn by row 1 (carrying status) and by a section
 * header (carrying its collapse chevron).
 *
 * `-mr-2` cancels the line's `gap-2`, so the column owns the gap rather than
 * sitting beside it and text starts at exactly 22px on either. That is what
 * puts a header's label on the same x as every title beneath it: the header's
 * own chevron box was 18px, so its label hung 4px left of the column it
 * labels. Reserved even when it draws nothing, so nothing shifts.
 */
export const LEADING_COLUMN_CLASS =
  "-mr-2 flex w-[22px] shrink-0 items-center justify-center";

/**
 * The box a mark sits in, whatever its own artwork measures.
 *
 * Intrinsic: the caller passes the size for its line (`ROW1_ICON`,
 * `ROW2_ICON`), and this centres the artwork inside it. Centring is the whole
 * job — a logo mask and a fallback dot are different widths, and without a
 * shared box they would sit on different axes within the same column.
 */
export const GLYPH_BOX_CLASS = "flex shrink-0 items-center justify-center";
