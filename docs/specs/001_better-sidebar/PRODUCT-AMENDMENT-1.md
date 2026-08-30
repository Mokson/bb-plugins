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
- **B51.5** (auto) **Only the time slot is fixed-width.** Time is present on every
  row, so it is the only element that can define a stable right-hand column, and the
  only one worth aligning. The child count renders only when `childCount > 0` and the
  status glyph only when the indicator draws something; **both occupy zero width when
  absent.** The title is `min-w-0 flex-1` and truncates only once it genuinely runs out
  of room after the present elements are laid out. On a row with no children and no
  status glyph — the common case — the title runs all the way to the time.
- **B51.6** (auto) Anything revealed on **hover** reserves no layout width and does not
  shift the title when it appears. A hover affordance replaces or overlays the trailing
  content rather than being appended beside it, the pattern
  `.bb-refs/bb-plugin-t3sidebar/src/ThreadCard.tsx` uses (`group-hover/card:hidden` on
  the status slot, with the hover buttons taking its place).

  > **Superseded.** B51.5 originally read "the trailing cluster is fixed-width per
  > element so the time column aligns down the whole list." That reserved count and
  > status width on every row, including the majority that have neither, and titles
  > truncated far earlier than necessary — reported by the user against the running
  > build: *"The title is truncated too soon reserving the space to icons which are
  > displayed only on hover."* Alignment of absent elements is not worth title width.
  > B51.1's chevron gutter still reserves width on every row: that one exists to align
  > titles across rows, which is a benefit the user asked for directly.

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

## B57 — Row 1, second pass: no count, chevron after the title, no left inset

Raised by the user against the running build. **B57 supersedes B51.1 and B53.2**;
B53.1, B53.3, B53.4 and B53.5 (the section header count, right-aligned and counting
roots only) are unaffected and stay exactly as they are.

Row 1 becomes:

```
[provider] title [chevron, parents only] ……………… [status] [time]
```

- **B57.1** (auto) **The per-row child count is removed entirely.** The chevron alone
  signals that a thread has children. This supersedes B53.2 — the count no longer
  appears anywhere on the row, in the trailing cluster or otherwise.
- **B57.2** (auto) **The chevron moves out of the left gutter to immediately after the
  title text**, hugging the end of the title so it reads as belonging to that thread.
  Its x position therefore varies row to row, which is correct: only parent rows carry
  one, so there is no column for it to break. **This supersedes B51.1 — there is no
  reserved chevron gutter any more, on any row.**
- **B57.3** (auto) **No left inset on the row.** The provider glyph starts at the row's
  left edge. The row's own horizontal padding on the left goes to zero.
- **B57.4** (auto) **The trailing cluster's spacing is uniform.** Exactly one gap of
  one size sits between adjacent *rendered* elements, so the distance between the
  status glyph and the time reads the same on every row. A mounted but zero-width
  element (`RowSignals`, which stays mounted because it owns the IntersectionObserver
  ref) contributes **no** gap — today each element carries its own margin, so the
  status-to-time distance changes depending on which siblings happen to draw.
- **B57.5** (auto) With the gutter gone, a childless row's title starts at the same x
  as a parent's, because neither reserves anything. B51.1's alignment goal is met by
  removal rather than by reservation.

> **Assumption, flagged for cheap correction.** "Remove paddings on left" is read as
> the row's base left inset and the chevron gutter — **not** the per-depth indent that
> makes nesting visible. B9 requires a child to render visibly beneath its parent, and
> the screenshots show that indent working. If the intent was a fully flat list with no
> nesting indent either, say so; it is a one-line change.

## B66 — the status glyph is coloured, and the spinner spins

**Supersedes B22.** B22 said colour is used *only* for Needs-you and error, and that
working is distinguished by motion rather than hue — chosen in round 7 when the brief
was "minimalistic, not a large badge or coloured row". The user has since seen it
running and asked for colour. That constraint is relaxed deliberately; the *other* half
of B22 stands, and this is not a licence for coloured row backgrounds or filled badges.

### Palette

bb's own sidebar (`.bb-refs/bb-sidebar/src/StatusSlot.tsx:96-118`) already has a status
palette, and using different colours from it would mean a hue says one thing here and
another in bb's own list — the exact trap B22 was written to avoid. So the palette is
bb's, with one addition: bb groups working and planning both as sky, while our
five-state vocabulary keeps them distinct, so planning takes violet.

| State | Indicators | Colour |
| --- | --- | --- |
| Needs you | `waiting-for-input` | `text-indigo-600 dark:text-indigo-300` |
| Error | `unread-error` | `text-red-700 dark:text-red-300` |
| Working | `runtime`, `workflow`, `background-agent`, `background-command` | `text-sky-600 dark:text-sky-400` |
| Planning | `plan-mode`, `goal` | `text-violet-600 dark:text-violet-400` |
| Draft | `draft`, `working-draft` | `text-amber-700 dark:text-amber-300` |
| Unread | `unread-success` | `text-emerald-700 dark:text-emerald-300` |
| Idle | `none` | nothing drawn |

- **B66.1** (auto) Every pair is a light/dark pair. A single hue that only works in one
  theme is a defect — the user runs dark on desktop and the phone may differ.
- **B66.2** (auto) B20 is unchanged and still load-bearing: an indicator outside the
  set draws **nothing** and throws nothing.
- **B66.3** (auto) B14 is unchanged: colour lives on the glyph only. **No coloured row
  background, no filled badge, no tinted title.** Unread is still font weight alone.

### Animation

- **B66.4** (auto) `runtime` renders the spinner glyph with **`animate-spin`**. It
  currently uses `animate-pulse`, so the spinner fades in and out instead of turning —
  a spinner that does not spin reads as a rendering bug, which is what it is.
- **B66.5** (auto) `workflow`, `background-agent` and `background-command` keep a
  gentle `animate-pulse`. They are active but not a single determinate operation, so
  they should read as alive without competing with the spinner for attention.
- **B66.6** (auto) `plan-mode`, `goal`, `draft`, `working-draft` and `unread-success`
  carry **no animation**. Motion means "something is happening right now"; a draft is
  not happening.
- **B66.7** (auto) No new keyframes. `animate-spin` and `animate-pulse` are stock
  Tailwind; bb's shine sweep was considered and rejected because it needs a keyframe
  this plugin would have to add.

## B63 — the PR chip is coloured by state, with breakage overriding

**Supersedes B34.** B34 tinted the chip by `attention` — bb's rolled-up "does this
need you" roll-up — with merged special-cased. The user asked for the PR's **state**,
and the SDK carries that as a separate field. The two answer different questions:
`state` is *what is this PR*, `attention` is *do I need to act*.

Colour now follows **GitHub's own palette**, because that is the language the user
already reads PRs in everywhere else, and a plugin that uses green and red to mean
something different is worse than one that adds no colour at all.

| `state` | Colour |
| --- | --- |
| `draft` | muted / grey |
| `open` | green |
| `merged` | purple |
| `closed` | red |

- **B63.1** (auto) **Breakage overrides state.** An `open` PR whose `attention` is
  `checks_failed` or `conflicts` renders **red**, not green. This is the one case worth
  interrupting a glance, and it is why pure state colouring was rejected.
- **B63.2** (auto) `attention` keeps its full role **in words** on the hover card
  (B35) — "Checks failed", "Changes requested", "Ready to merge". Nothing is lost by
  moving colour to `state`; the actionable detail simply stops competing with the
  identity signal.
- **B63.3** (auto) Clicking the chip opens the PR through the host's `openUrl` and
  never navigates the thread. Already built (`PrChip.tsx:74` via `ThreadRow`'s single
  shared handler, §7's B36 ruling); restated here because the user named it as a
  requirement.
- **B63.4** (manual) **None of this has ever rendered.** QA found zero threads with a
  pull request in the user's bb, so the chip, its colours, its hover card and its click
  are all *untested in practice*. Any QA pass that can reach a thread with a real PR
  must exercise all four states, and must confirm `openUrl` actually reaches GitHub
  from a remote `getbb.app` session as well as from the desktop app.

## B56 — Row 2 protects the project name from a long branch

Reported by the user against the running build, with a screenshot: a row showing
project `bb-plugins` and branch `bb/create-customizable-plugin-version-…` rendered the
project as `bb-pl…` while the branch kept roughly four times the width.

**The cause is that both labels shrink proportionally**, which sounds fair and is not.
As plain flex children they shrink in proportion to their natural width, so with the
project at ~60px, the branch at ~250px, and ~180px available, the project still gives
up ~25px — enough to destroy a ten-character name — while the branch, which had width
to spare, keeps 145px it does not need. Proportional shrinking is the defect.

- **B56.1** (auto) The **branch/workspace label truncates first and absorbs all of the
  deficit.** It is the longest, the most repetitive across rows, and the least
  identifying: its tail is usually a ticket slug the user can infer.
- **B56.2** (auto) The **project name renders in full** whenever it fits within a cap
  of roughly 45% of row 2's width. It truncates only when it alone exceeds that cap,
  never merely because the branch beside it is long.
- **B56.3** (auto) A row with a short project and a short branch still renders both in
  full with the line ending where its content ends — B56 changes only what happens
  under pressure.
- **B56.4** (auto) The PR chip never shrinks. It is a fixed, meaningful token
  (`#1234`) and a truncated PR number is worse than useless.
- **B56.5** (manual) Verified at 390px with a real long branch, which is where the
  user found it — a desktop-only check would not have caught this.

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
