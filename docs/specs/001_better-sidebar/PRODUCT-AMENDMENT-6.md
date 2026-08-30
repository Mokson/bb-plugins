# PRODUCT amendment 6 — list inset, the working glyph, and working children

Three defects the user found running the plugin on a real sidebar
(`evidence/2026-08-30-sidebar.png`).

## B73 — the list sits on the host's 8px column (supersedes B57.3 in part)

The scroll container carries no horizontal padding (`ThreadList.tsx:149`, `py-1`).
The row carries `pr-2` and nothing on the left (`ThreadRow.tsx:164`), so the time
label stops 8px short of the right edge while the provider glyph touches the left
edge. The section header and the project filter each carry their own `px-2`, so
chrome sits 8px in and rows sit at 0.

- **B73.1** (auto) The **scroll container** carries the inset: `px-2`, the same 8px
  bb's own chrome above the list uses for "New thread" and the search field. One
  column runs the whole panel.
- **B73.2** (auto) `pr-2` comes **off the row**, and `px-2` comes off the section
  header (`ThreadList.tsx:222`) and off the project filter
  (`ProjectFilter.tsx:35`). Two insets in series would put chrome at 16px.
- **B73.3** (auto) **B57.3 survives**: the row's own left inset stays zero, so a
  childless row's title starts at the same x as a parent's. The container moves the
  whole column; it does not reintroduce a per-row gutter. The per-depth indent (B9)
  is unchanged.
- **B73.4** (auto) Row 1 and the section header share a left edge, and row 1's
  trailing time shares a right edge with the section count. Assert both as the
  same computed inset, not as two independent classes.

## B74 — the working glyph turns (supersedes B66.4's artwork, not its ruling)

`runtime` draws the `spinner` path: eight spokes at 45-degree intervals
(`Glyph.tsx`). The shape is **rotationally symmetric every 45 degrees**, so under
`animate-spin` it is identical eight times per revolution and reads as a shimmer
rather than a turn. B66.4 was right that it must rotate; the artwork could not
show it.

- **B74.1** (auto) `runtime` draws an **open arc** — roughly three quarters of a
  circle, the `loader-circle` shape — and keeps `animate-spin`. An arc has a
  visible start and end, so one rotation is legible at 14px.
- **B74.2** (auto) The change is **artwork only**. The sky hue and `animate-spin`
  are unchanged, and B66.1's light/dark pairing is unchanged.
- **B74.3** (auto) **`workflow`, `background-agent` and `background-command` are
  untouched** — B66.5 stands. They keep their own glyphs and `animate-pulse`,
  because a background command running is not the same event as your turn running,
  and the distinct artwork is what says so.
- **B74.4** (auto) The old `spinner` path stays in `PATHS` **only if something else
  still references it**. If `runtime` was its only caller, it is dead and goes with
  a grep in the commit message.

## B75 — working children show in the header chip

The chip (B58) reacts only to attention: `hasPendingInteraction` on any child turns
it amber and the label reads "Needs you". A child that is simply **running** — the
common state during a fan-out — has no mark at all.

- **B75.1** (auto) A child glyph in the cluster gets a **thin sky ring** when that
  child's `indicator` is one of `runtime`, `workflow`, `background-agent`,
  `background-command` — the same four the sidebar row draws sky. Do not invent a
  second definition of working.
- **B75.2** (auto) The label reads **`N working`** when any child is running, where
  N counts running children, not all children. It falls back to `N children` when
  none is.
- **B75.3** (auto) **No motion.** The ring is static and the cluster does not pulse.
  This is a signal on a chip the user is not looking at; motion in the header
  competes with the thread they are reading.
- **B75.4** (auto) **Attention still wins.** A chip with both a pending child and a
  running child reads "Needs you" and stays amber (B58.3). The rings still draw —
  they mark different children — but the label and the chip hue are attention's.
- **B75.5** (auto) On `isCompactViewport` the label is dropped (B58.4) and **the
  rings remain**. They are the only working signal the phone gets, which is the
  reason they are a mark and not just a word.
- **B75.6** (auto) A ringed glyph must not grow the cluster's height or shift the
  chip's 28px box (B58.5). Ring inside the glyph's existing box.
