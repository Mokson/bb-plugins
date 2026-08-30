# PRODUCT amendment 1 — row layout, counters, density

Raised by the user against the plugin **running on his phone**
(`mksn.getbb.app`, Brave/Android), with a screenshot. This is new product
direction, not a correction of a mis-read spec, so it amends PRODUCT.md rather than
living in TECH.md §7. Invariants continue from B51.

It supersedes parts of B12, B15, B17, B23-B25 and B7/B10 as noted. Where this file
and PRODUCT.md disagree, **this file wins**.

## Deliberate reversal, recorded

B23-B25 placed the provider glyph **trailing on row 2**, chosen in interview round 3
because it pinned row 2's right edge across rows with no branch and no PR. Children no
longer have a row 2 (B52), so that reason no longer holds. The user has moved the
provider glyph to **leading**. This is a decision reversal with a changed premise, not
drift.

## B51 — Row 1 is one fixed layout, for every row

```
[chevron gutter] [provider] title ……………… [child count] [status] [time]
```

- **B51.1** (auto) Every row reserves a fixed-width chevron gutter whether or not it
  has children, so every title starts on the same vertical line. A childless row
  renders an empty gutter, never a shifted title.
- **B51.2** (auto) The provider glyph renders immediately left of the title, on every
  row. Its resolution and fallbacks are unchanged from B23-B25 (masked logo, per-theme
  `iconTint`, neutral dot when `logoUrl` is null or the provider is absent).
- **B51.3** (auto) The trailing cluster is, in this order: child count when
  `childCount > 0`, then the status glyph, then the relative time. Time sits at the
  row's right edge.
- **B51.4** (auto) Time renders on **every** row, parents and children alike, and no
  longer appears on row 2.
- **B51.5** (auto) The trailing cluster is fixed-width per element so the time column
  aligns down the whole list, the same argument that governs the status slot today.

## B52 — Child threads have no second row

- **B52.1** (auto) A row with `depth > 0` renders row 1 only, whatever the `secondRow`
  setting says. On a child, project and workspace repeat the parent's and are noise.
- **B52.2** (auto) `secondRow` (B18/B49) therefore governs **root rows only**.
- **B52.3** (auto) Row 2, where it renders, is `project · workspace · PR chip` — time
  has moved to row 1 per B51.4.
- This supersedes **B12** ("a child row shows its own relative time on row 2"): the
  child still shows its own relative time, now on row 1.

## B53 — Counters are right-aligned

- **B53.1** (auto) A section header's count renders at the far right of the header row,
  not immediately after the label. `TODAY 20` becomes `TODAY ………… 20`.
- **B53.2** (auto) A parent's child count renders in the row's trailing cluster
  (B51.3), never before the title. A count before the title reads as part of the
  title.
- **B53.3** (auto) The chevron remains the collapse affordance and stays in the gutter;
  only the number moves.
- **B53.4** (auto) **A section header counts its ROOT rows only — never nested child
  threads**, whether or not those children are currently expanded. Counting every row
  makes the number jump constantly: subagents spawn and finish continuously, so the
  count churns while nothing the user cares about has changed. A section's count answers
  "how many threads are in here", and a subagent is not a thread the user started.
  The parent's own child count (B53.2) is where subagent volume is reported.
- **B53.5** (auto) B53.4's count is therefore invariant under expanding or collapsing
  any subtree inside the section. Assert exactly that: expand a parent, the section
  count does not change.

## B54 — Density matches bb's own sidebar

Measured from the running host at `http://127.0.0.1:38886`, via computed style on
bb's own thread row — these are targets, not approximations:

| Property | bb's own row | Requirement |
| --- | --- | --- |
| row height | `28px` | row 1 matches `28px` |
| padding | `0 0 0 8px` | match |
| flex gap | `8px` | match (currently `gap-1` = 4px) |
| font size | `13px` | match (currently `text-sm` = 14px) |
| corner | `rounded-md` | match |

- **B54.1** (auto) A root row with no second row is `28px` tall, the same as a
  built-in bb row.
- **B54.2** (manual) Placed beside bb's built-in list at the same viewport, rows align
  on the same baseline grid and the same left text edge.
- **B54.3** (auto) The "New thread" row above the list is host chrome at `px-2 py-2`;
  the list's own horizontal padding matches its `8px`, so the two do not step.

## B55 — Mobile is a tested target, not an inference

The user runs this on a phone through `bb connect`. `isCompactViewport` is true there.

- **B55.1** (manual) Every layout invariant above is verified at a phone viewport
  (~390x844), not only at desktop width.
- **B55.2** (manual) The trailing cluster does not wrap, overlap, or clip the title at
  that width; the title truncates instead.
- **B55.3** (auto) B32 still holds: no dossier on compact viewports. The provider
  glyph, counters and time all still render.
- **B55.4** (manual) Tap targets — chevron, PR chip, row — remain independently
  tappable at phone width without the chevron stealing a row tap.

## Unchanged

Everything not named here stands: precedence and bucketing (B1-B11), the five-state
glyph vocabulary and its colour rules (B20-B22), the dossier (B26-B32), the PR chip's
tinting and hover card (B33-B36), the host contract (B43-B47), and the three settings
(B48-B50).
