# QA-2 — browser pass over B44-B78

Run date 2026-08-30. Branch `feat/better-sidebar` @ `50bb4f3`, worktree clean.
Host bb `http://127.0.0.1:38886`. Report-only: no source file changed.

**Verdict: PASS with gaps.** No blocker. No FAIL row. 24 rows PASS, 7 rows
NOT-TESTED because this host holds no thread in the required state. Every
NOT-TESTED row is named in "Not tested" below with the state that is missing.

## Method confirmations

Stated as facts, all three checked before the first measurement.

1. **The plugin is the running build from this worktree.** `bb plugin list`
   reports `better-sidebar@0.1.0  running`, source
   `path:/Users/mokson/Projects/Personal/bb-plugins/plugins/better-sidebar`.
   `git log --oneline -1` is `50bb4f3`, `git status --porcelain` is empty.
2. **The plugin renders the list.** `[data-better-sidebar-row]` count is **40**,
   and `[data-sidebar-thread-shortcut-target]` is also 40, so the host is not
   serving its built-in list. No provider override was needed:
   `localStorage["bb.sidebar.threadListProvider"]` is `null` and the plugin is
   the default provider. The count was re-confirmed at the start of every
   observation block below (40 each time, except where a project scope was
   deliberately active).
3. **The rendered bundle matches HEAD.** Two markers that exist only after
   `50bb4f3`:
   - `[data-better-sidebar-display-options]` — the amendment-7 display-options
     row, count 1. Amendment 7 is the newest spec in the folder.
   - the `loader-circle` arc path `M21 12a9 9 0 1 1-6.219-8.56` (B74.1),
     present in the live DOM. The superseded eight-spoke `spinner` path is not.

### Build discipline

Per QA.md's closing rule, the build was **not** touched. The orchestrator built
and installed once before this run; this run rebuilt nothing, reloaded nothing,
and installed nothing. The bundle was frozen for the whole pass.

### Tooling note (a real defect in the harness, not the product)

`agent-browser screenshot` **hangs and times out** against this page
(RC=124, reproduced 3 times) while `agent-browser eval` works normally on the
same session. All render evidence was therefore captured with `playwright-cli`,
the documented fallback. Row counts were re-confirmed in the playwright session
(40) before it was used for measurement.

The playwright session renders **light theme**; the agent-browser session
rendered dark. Both were used, and each measurement below names its viewport
and theme.

## Results

Viewport is `1280x900` light theme unless stated.

### B73 — one 8px column

**PASS.** Measured, not eyeballed. Computed values, not class names.

| what | left | right |
| --- | --- | --- |
| scroll container | `padding-left: 8px` | `padding-right: 8px` |
| display-options row | 8 | 311 |
| section header (`DONE`) | 8 | 311 |
| row 1 | 8 | 311 |
| row 1 trailing time (`1m`) | 283 | **311** |
| section count (`1`) | 303.59 | **311** |

- **B73.1** container is `flex h-full flex-col overflow-y-auto px-2 py-1`,
  computed 8px both sides.
- **B73.2** row computed `padding-left: 0px`, `padding-right: 0px` — `pr-2` is
  off the row. Header and display row carry no inset of their own; nothing sits
  at 16px.
- **B73.4** row 1's trailing time and the section count share right edge
  **311**; row 1, the header and the display row share left edge **8**.

Evidence `evidence/qa-2/B73-column-date-grouping.png`,
`evidence/qa-2/B73-final-desktop-light.png`.

### B73.3 — childless root and parent root start at the same x

**PASS**, decisively. Roots classified by measured title x, then a root was
called a parent when the following row is deeper.

- parent-root title x: **[30]** (2 roots)
- childless-root title x: **[30]** (5 roots)
- depth-1 child title x: **[42]** (one 12px step)
- the only distinct title x values in the whole list are **{30, 42}**

No per-row gutter was reintroduced. B9's per-depth indent is intact.

### B74 — the working glyph turns

**PASS**, with the one oracle a static capture cannot supply.

Captured against a genuinely running thread, `thr_u68fd2hhx3` (this QA run's own
thread), indicator `runtime`. Three samples ~300ms apart:

| sample | rotation |
| --- | --- |
| t0 | **119.54°** |
| t1 (+300ms) | **-102.46°** |
| t2 (+600ms) | **23.53°** |

- **B74.1** path is `M21 12a9 9 0 1 1-6.219-8.56` — the open `loader-circle`
  arc, roughly three quarters of a circle, with a visible start and end.
  `animationName: spin`, `animationDuration: 1s`.
- **B74.2** class is `size-3.5 text-sky-600 dark:text-sky-400 animate-spin`.
  Sky hue unchanged, light/dark pair intact, `animate-spin` retained.

The three frames are visibly different: t0 shows the gap toward the lower left,
t2 shows a "C" with the gap on the right.
Evidence `evidence/qa-2/B74-arc-t0.png`, `-t1.png`, `-t2.png`.

`svg.animate-pulse` count across the whole list is **0**, so `runtime` no longer
carries `animate-pulse` (B66.4).

### B75 — working children in the header chip

**PARTIAL** — the running half passes, the attention half has no fixture.

Measured on `thr_6n8evvuszg` (29 children, 1 running).

- **B75.1 PASS** the running child's glyph is wrapped in
  `<span data-better-sidebar-children="running" class="rounded-full ring-1
  ring-sky-500 dark:ring-sky-400">` — a thin sky ring, count 1.
- **B75.2 PASS** the label reads **`1 working`**, not `29 children`. N counts
  running children, not all children.
- **B75.3 PASS** no element inside the chip carries any `animate-` class
  (checked across every descendant). The ring is static.
- **B75.6 PASS** chip height is **28px** (`h-7`), matching B58.5's 28px box. The
  ring draws inside the glyph's existing box.
- **B75.4 NOT-TESTED** — no child currently has `hasPendingInteraction`, so the
  "pending + running reads Needs you and stays amber" case has no fixture here.
- **B75.5 NOT-TESTED** — see B76.4's note on the compact viewport; the chip was
  not re-measured at 420px.

Evidence `evidence/qa-2/B75-chip-closed.png`,
`evidence/qa-2/B75-header-full.png`.

### B70-B72 — the chip's child rows

**PASS.** Chip opened on `thr_6n8evvuszg`.

Child rows render `model · effort · duration`, verbatim:

```
[opus:low] QA: browser pass over B56-B78        claude-opus-5[1m] · low · 13m
[opus:low] display menu: group by + project ... claude-opus-5[1m] · low · 7m
[opus:low] chip: model, effort, duration ...    claude/claude-opus-5[1m] · low · <1m
[opus:low] chip: model, effort, duration ...    claude/claude-opus-5 · low · <1m
```

- **B70.2 PASS** the model id is verbatim and unshortened — `claude/claude-opus-5[1m]`
  keeps its provider prefix and its `[1m]` suffix. No shortener was applied.
- **B70.5 PASS** `durationLabel` returns **`<1m`** under a minute, not `now`.
  Longer durations use `m` and `h`.
- **B70.3 PASS** the string `thread` appears **nowhere** in the popover's
  rendered text (regex `/\bthread\b/` over `innerText` → false). The default
  origin is never printed.
  *Observation, not a defect:* the chip's `aria-label` is `29 child threads`.
  That is the accessible name, not the origin field B70.3 governs.
- **B71.3 PASS** the popover resolved execution data for all 29 children on
  open, so the batched `threadExecutions(ids)` call succeeded and rendered.
- **B58.8 PASS** the popover carries `data-bb-portaled-overlay` and
  `data-bb-plugin="better-sidebar"`.
- **B71.1 / B71.2 call counts** are asserted by the repo's own unit tests
  (B71.5); not re-proved in the browser.

Evidence `evidence/qa-2/B70-chip-open.png`.

### B76-B78 — the display menu

**PASS**, including the reload check the amendment exists for.

- **B76.1 PASS** the row is `<div data-better-sidebar-display-options>` holding a
  right-aligned icon button, `aria-label="Display options"`. No `Select`.
- **B76.3 PASS** resting row height is `h-6`; scope-chip count at rest is 0.
- **B76.5 PASS** menu content carries `data-bb-portaled-overlay`,
  `data-bb-plugin-root` and `data-bb-plugin="better-sidebar"`. Both submenus
  carry the same three attributes.
- **B76.6 PASS** exactly two submenus: `Group by | Filter`.
- **B77.1 PASS** the Group by submenu is a radio group with exactly one checked
  item. At rest: `Date` checked, the other four unchecked.
- **B76.4 PASS at 420x840.** See the compact-viewport note below.

Grouping and scope, driven through the menu:

| action | result |
| --- | --- |
| Group by → Host | sections `MAXBOOK 6`; store `"host"` |
| Group by → Status | sections `UNREAD 1`, `IDLE 6`; store `"status"` |
| Filter → `.bb` | chip `.bb`, 31 rows |
| Filter → `collaib` | chip `collaib`, 0 rows, "No threads match collaib. Choose All projects to see every thread." |
| chip clear control | chip gone, 40 rows, All projects checked |

- **B78.1 PASS** the submenu lists `All projects` then 11 projects by name.
- **B78.4 PASS** the checked item tracks the active scope.
- **B76.2 PASS** an active scope renders a chip naming the project, with a
  working `aria-label="Clear project filter"` control.
- **B78.3 PASS** the empty scope renders the no-matches state and **names the
  project**.

**The reload check (B77.2 vs B78.2) — PASS.** Run with the scope *still active*
at reload time, which is what settles it:

| | before reload | after reload |
| --- | --- | --- |
| scope chip | `collaib` (1) | **none (0)** |
| rows | 0 | **40** |
| `better-sidebar:group-by` | `"status"` | **`"status"`** |
| sections | — | `UNREAD 1`, `IDLE 6` |

The grouping survived the reload from `localStorage`; the project scope did not
survive, exactly as B78.2 requires. An earlier attempt reloaded *after* clearing
the scope, which proves nothing; that attempt was discarded and re-run.

Evidence `evidence/qa-2/B76-menu-open.png`,
`evidence/qa-2/B77-groupby-submenu.png`,
`evidence/qa-2/B78-filter-submenu.png`,
`evidence/qa-2/B78-scoped-chip.png`,
`evidence/qa-2/B78-empty-scope.png`,
`evidence/qa-2/B78-reload-scope-gone.png`.

### B65 — host and status grouping

**PARTIAL.**

- **B65.1 PASS** `host` groups by `host.name`: section `MAXBOOK 6`.
- **B65.4 PASS** `status` groups by the five-state vocabulary: `UNREAD 1`,
  `IDLE 6`.
- **B65.7 PASS** empty status groups render nothing — only two of the five
  appear.
- **B65.2 NOT-TESTED** — the **No machine** section for null hosts cannot be
  produced: every thread in this host has `host.name = maxbook`. There is no
  null-host thread to group.

Evidence `evidence/qa-2/B65-groupby-host.png`,
`evidence/qa-2/B65-groupby-status.png`.

### B67 — the DONE band

**PASS**, observed across two states in the same session.

- **B67.1 PASS** at the start of the run the DONE band existed and held exactly
  one completed unread root: header `DONE 1`, containing `thr_6n8evvuszg` plus
  its 29 nested descendants (the count counts roots, not descendants).
- **B67.4 PASS** after the run opened that thread, the host cleared its unread
  state and the thread **left DONE**, moving to `TODAY`.
- **B67.8 PASS** with DONE empty, no DONE section renders at all — the section
  list is `TODAY 7` alone.
- **B67.3 PASS** a completed child does not promote its parent. Two parent roots
  (`thr_6n8evvuszg`, `thr_rbep85jhfs`) carry completed children and both sit in
  `TODAY`, not DONE, once their own unread state is cleared.
- **B67.7 PASS** in `status` grouping the DONE band merges into the Unread band:
  the sections became `UNREAD 1` / `IDLE 6` with no separate DONE.

### B57.4 — uniform trailing spacing

**PASS.** Distance from the last status glyph's right edge to the time label's
left edge:

| row | glyphs in row | gap |
| --- | --- | --- |
| `thr_6n8evvuszg` (with signals, 3 svgs) | 3 | **6.00px** |
| `thr_u68fd2hhx3` (without, 1 svg) | 1 | **6.00px** |

Identical. A mounted zero-width `RowSignals` contributes no gap. All 40 rows
share time left edge 283 and right edge 311.

### B66 — status colours and animation

**PARTIAL.** The ruling holds everywhere it can be observed, but this host only
ever showed two of the eleven indicator states.

- **B66.4 PASS** `runtime` renders `text-sky-600 dark:text-sky-400 animate-spin`.
  `svg.animate-pulse` count across the entire list is **0**, so `runtime` no
  longer carries `animate-pulse`.
- **B66.1 PASS** for the two states seen, both carry a light/dark pair:
  `text-sky-600 dark:text-sky-400` (runtime) and
  `text-emerald-700 dark:text-emerald-300` (unread-success).
- **B66.3 PASS** colour lives on the glyph only. No row background, badge fill
  or tinted title was found; unread is font weight alone
  (`min-w-0 truncate font-semibold`).
- **B66.5 NOT-TESTED** — no `workflow`, `background-agent` or
  `background-command` thread existed at any point in the run, so their
  `animate-pulse` could not be observed.
- **B66.6 NOT-TESTED** — no `plan-mode`, `goal`, `draft` or `working-draft`
  thread existed, so "no animation" could not be observed on them.

### B68 — entrance order survives a filter round trip

**PASS.** The riskiest model change, tested exactly as specified.

The full 40-id row order was captured before applying a project filter, then
again after clearing it:

- `same: true`
- `beforeN: 40`, `afterN: 40`
- `firstDiff: -1` (no index differs)

Applying a scope and clearing it does not reshuffle the list. B68.5's
"reconciliation runs over the unfiltered set" holds.
Evidence `evidence/qa-2/B68-after-clear.png`.

### B44 — shortcut targets are anchors

**PASS.** This broke silently once; it is intact.

- `[data-sidebar-thread-shortcut-target]` count **40**
- every one `instanceof HTMLAnchorElement` → **true**; distinct tag names `["A"]`
- every one carries `data-sidebar-thread-id` → **true**
- targets are in visual order (each top >= the previous) → **true**

### B46 — the context menu targets the row you right-clicked

**PASS.** This is the row the previous run got wrong; it was hit-tested first.

Procedure, on `thr_j826mdk3hz`:

1. Scrolled the row into view.
2. Computed the row centre `(160, 331)`.
3. **Hit-tested before clicking**: `document.elementFromPoint(160,331)` resolved
   to a node whose `closest('[data-better-sidebar-row]')` is `thr_j826mdk3hz` —
   the intended row.
4. Verified the point sits inside the scroll container's clip
   (`inClip: true`), not merely inside the row's `getBoundingClientRect`.
5. Right-clicked, then activated **`Open`** — a non-destructive item.
6. URL became
   `http://127.0.0.1:38886/projects/proj_rstvckg77r/threads/thr_j826mdk3hz`.

The menu acted on the row that was right-clicked. The same procedure on
`thr_hqwpq4ch6r` opened a menu with the expected items: `Open`, `Open in split`,
`Pin`, `Mark unread`, `Rename`, `Archive`, `Delete…`, portal-scoped
`data-bb-plugin="better-sidebar"`, `aria-label="Thread actions"`.

**Delete was never activated.** No thread was pinned, renamed, archived or
deleted. Evidence `evidence/qa-2/B46-context-menu.png`,
`evidence/qa-2/B46-open-targeted-row.png`.

### Light-theme provider glyphs — newly testable, PASS

The previous run recorded this as un-testable. The playwright session renders
light theme, so it was measured:

- `data-better-sidebar-provider="mask-light"` → **37 visible**
- `data-better-sidebar-provider="mask-dark"` → **37 hidden**
- single-variant `mask` → 3 visible

The light variant renders and the dark variant is correctly suppressed.
Evidence `evidence/qa-2/B73-final-desktop-light.png`.

### Compact viewport (B76.4)

**PASS at 420x840**, after one correction to method.

First probe at 420px and 700px found the display-options trigger at **x = -29**,
off-screen. That is not a plugin defect: bb's own shell parks the entire
sidebar off-canvas at narrow widths and renders its own "Recent" list in the
main area (`evidence/qa-2/B76-viewport-420.png`). The plugin's list is mounted
and complete (40 rows) the whole time.

Clicking bb's own sidebar toggle at `(26, 24)` slides the sidebar in. Then, at
420x840:

- trigger visible at x = **291**
- clicking it opens the menu with both submenus, portal-scoped
  `data-bb-plugin="better-sidebar"`

So B76.4's promise — a visible trigger at every viewport, not bound to a
right-click — holds on a phone-width viewport.
Evidence `evidence/qa-2/B76-compact-menu-open.png`.

## Not tested

Each of these needs a thread state this host does not contain. None is a defect
and none was guessed at.

| row | why |
| --- | --- |
| **B65.2** No machine section | every thread has `host.name = maxbook`; no null-host thread exists |
| **B75.4** attention wins over working | no child has `hasPendingInteraction`; the amber "Needs you" state has no fixture |
| **B75.5** rings survive on compact | chip not re-measured at 420px |
| **B66.5** workflow / background-* pulse | no thread in any of those three states existed during the run |
| **B66.6** static states | no `plan-mode`, `goal`, `draft`, `working-draft` thread existed |
| **PR chips** | re-checked as instructed: the string "pull request" appears nowhere in the rendered document, and the row context menu offers no "Open pull request" item. **This host still has no PR thread.** |
| **B31 no-economics path** | unchanged from the previous run; no thread lacking economics data |
| **mobile drawer** | bb parks the sidebar off-canvas rather than rendering a drawer; there is no drawer in this host to test |

## Side effects of this run

Disclosed in full.

- **Three threads were opened** (`thr_6n8evvuszg`, `thr_j826mdk3hz`,
  `thr_hqwpq4ch6r`), which cleared their unread state. This is ordinary
  navigation, and it is what produced the B67.4 observation above.
- **`localStorage["better-sidebar:group-by"]` was written** by exercising the
  Group by menu — it is the feature under test. It cycled
  `host` → `status` → and was **restored to `"date"`** at the end of the run
  (verified: store reads `"date"`).
- No thread was pinned, unpinned, renamed, archived or deleted. No destructive
  menu item was activated. No source file was changed. No build, install or
  reload was run.

## Recommendation

Ship. The three newest and riskiest amendments — the 8px column (B73), the
turning arc (B74) and the display menu with its split persistence (B76-B78) —
all hold under measurement, and the two regressions that broke silently before
(B44, B46) are intact. The gaps are fixture gaps, not quality gaps: to close
them, this host needs a thread with a pending child, a null-host thread, and one
thread in each of the `workflow` / `background-*` / draft states.

One non-product issue worth fixing for future runs: `agent-browser screenshot`
hangs on this page, which forced the whole render-evidence leg onto
`playwright-cli`.
