# QA — better-sidebar

**Verdict: FAIL.**

Three defects reproduce through the real UI, two of them user-visible on the
plugin's core surfaces:

- **Blocker** — the row context menu is bound to the wrong thread. Right-clicking
  row *X* and choosing any item acts on some other thread entirely. Reproduced
  three times against three different rows.
- **Blocker** — `Rename` never opens an editor (a consequence of the same wrong
  binding plus the FocusScope path never being reached on the row aimed at).
- **High** — the `rowSignals` batch never fires. Scrolling the whole list top to
  bottom issues zero plugin RPCs, so B37-B40's four signal glyphs can never draw.
- **High** — rows do not drag out to a split pane. `splitProps` is spread but no
  drag attribute reaches the DOM; a drag to the main area is treated as a click.

Everything the amendment (B51-B55) specifies about row geometry measures correct
at 320px panel width, in both the desktop and the drawer instance.

Branch `feat/better-sidebar` @ `d0d8a56`. Host bb at `http://127.0.0.1:38886`,
plugin list confirmed active before every observation
(`[data-better-sidebar-row]` count > 0). Evidence in `evidence/`.

---

## Environment deltas from the packet

| Packet said | Environment | Effect |
| --- | --- | --- |
| ~170 threads across 4 providers | 113 threads; providers claude-code 103, codex 7, pi 2, acp-cursor 1 | fewer provider glyph variants observable |
| ~80 `acp-cursor` threads drive B31's no-economics path | exactly 1 `acp-cursor` thread, and it is not among the threads the host feeds the slot | B31 NOT TESTED |
| — | the host feeds the slot ~27 threads, all in TODAY (plus NEEDS YOU when one appears); the set is identical in every project | date bucketing past TODAY, and every PR chip row, NOT TESTED |
| viewport 390x844 | `agent-browser set viewport 390 844` resizes the window but the page still matches `(min-width: 768px)`; the sidebar panel stays `visibility: hidden; left: -320px` and never slides in | B55 visual and tap-target rows BLOCKED; geometry rows carried by measurement |

---

## Matrix

### Nine runtime assumptions

| # | Row | Status | Evidence |
| --- | --- | --- | --- |
| A1 | Rename editor opens from the context menu and keeps focus | **FAIL** | see A1 detail |
| A2 | Portal scoping; host outside-click does not dismiss dossier / PR card / menu | PASS | menu and dossier both survive open; content carries `data-bb-portaled-overlay`, `data-bb-plugin-root`, `data-bb-plugin`; dossier dismisses only on pointer leave / outside click |
| A3 | Controlled HoverCard timing vs the plugin's pointer state machine | PASS | hover on `[data-better-sidebar-hover-trigger]` → `data-state="open"`, dossier content rendered, no flicker across repeated hovers |
| A4 | Pointer bubbling across the PR chip's SVG children (close/reopen flicker) | NOT TESTED | zero `[data-better-sidebar-pr]` chips exist across every project in this host |
| A5 | Event ownership: context-menu trigger / hover trigger / split-drag / row click | **FAIL** (partial) | row click and hover both work; the context-menu trigger resolves to the wrong row (see B46 detail); split drag never engages (see B45 detail) |
| A6 | Document capture listeners see pointerup from a split drag | PASS | capture listener logged `["up","DIV"]` on release over the main area at (800,450) |
| A7 | IntersectionObserver reports the signal span inside the sidebar overflow container | **FAIL** | see A7 detail |
| A8 | `scrollIntoView` + focus on bucket-jump headings, no host interception | PASS | focus on a row anchor, `Alt+ArrowUp` → `document.activeElement` = `BUTTON "TODAY 6"`, `tabindex="-1"` |
| A9 | CSS-mask provider glyph in both themes | PARTIAL | dark theme confirmed: `mask-image: url(/api/v1/system/providers/<id>/logo)`, `background-color: rgb(217,119,87)` for a tinted provider and `oklab(0.44 0 0 / 0.7)` (= `bg-muted-foreground/70`, TECH §7 B23) for an untinted one, 12px box. Light theme not verified — forcing `.light` on `documentElement` left the `dark:block` span visible, and no host theme switch was reachable in budget. `evidence/A9-light-theme-glyphs.png` |

### Host contract

| Row | Status | Evidence |
| --- | --- | --- |
| B44 shortcut targets | PASS | 27 targets, `every(x => x instanceof HTMLAnchorElement)` = true; `Control+4` opened `thr_ubek848wxs`, the 4th visual row |
| B45 drag to split | **FAIL** | see detail |
| B46 context menu contents | PARTIAL | items exactly `Open · Open in split · Pin · Mark unread · Rename · Archive · Delete…`; "Open pull request" correctly absent with no PR (no PR thread existed to prove the positive case); Delete not exercised — with the menu bound to the wrong thread, activating it would have deleted an unrelated thread |
| B46 context menu targeting | **FAIL** | see detail |
| B47 `onNavigate` after open | PASS (desktop) | row click navigates and the host search field clears; the mobile-drawer half is BLOCKED with B55 |

### Layout — desktop 1280x900 and the 320px drawer panel

Both viewports produce the same panel width (320px), so the geometry below holds
at both unless noted. `evidence/out-desktop.json`, `evidence/out-mobile.json`,
`evidence/B51-desktop-1280.png`, `evidence/B55-mobile-390.png`.

| Row | Status | Evidence |
| --- | --- | --- |
| B51 row-1 order | PASS | children of `[data-better-sidebar-row1]` in order: chevron gutter span, `[data-better-sidebar-provider]` span, `min-w-0 flex-1 truncate` title, trailing cluster |
| B51.1 chevron gutter on every row | PASS | gutter width 14px on all 27 rows including childless ones; title x is one value per depth (52 at `padding-left:8px`, 64 at 20px) |
| B51.3 trailing order + time at right edge | PASS | count → status glyph → time; every row's trailing right edge = 311 |
| B51.5 only the time slot is fixed-width | PASS | idle childless row trailing width = 34 (time 28 + gap); the signals span measures 0px when empty; count and status glyph are absent from the DOM, not zero-width placeholders. Rows with a count measure 61.1 / 68.3 |
| B52 no second row on children | PASS | every `padding-left:20px` row has exactly one child in its column wrapper; all 7 root rows have two |
| B53.1 header count right-aligned | PASS | label right edge 297.6, number spans 303.6→311, button right edge 319 |
| B53.4/B53.5 section count = roots only, invariant | PASS | `TODAY 7` with 27 rows rendered; collapse an 18-child parent → 9 rows, header still `TODAY 7`; expand → 27 rows, header still `TODAY 7` |
| B54.1/B54.3 density | PASS | row1 height 28px, gap 8px, font-size 13px, `padding-left: 8px`, `border-radius: 6px` — identical to bb's built-in row measured in the same session (28 / `0px 0px 0px 8px` / 8px / 13px / 6px) |
| B54.2 same left text edge as bb's list | **Paper cut** | bb's own row text starts at x=16; the plugin's title starts at x=52, because B51.1's chevron gutter and B51.2's provider glyph sit ahead of it. The amendment wins over B54.2, so this is a spec tension to record, not a defect |
| B55.2 no wrap, overlap or clipping | PASS (translated) | at panel width 320px: no row has `titleRight > trailingLeft`, min title-to-trailing gap 8px on all 27 rows, no per-row vertical overflow, no document horizontal scroll; titles truncate |
| B55.4 independently tappable chevron / PR chip / row | **BLOCKED** | the drawer never becomes visible at the harness's 390px window (see environment deltas). The chevron is a `role="button"` with `pointer-events-auto` inside a `pointer-events-none` wrapper and a `-inset-1.5` hit box, which is the right shape, but no tap was performed |
| B55.3 no dossier on compact viewport | **BLOCKED** | same cause; `isCompactViewport` never became true in this harness |

### Behaviour

| Row | Status | Evidence |
| --- | --- | --- |
| B1 precedence, NEEDS YOU above date buckets | PASS | a thread turning pending mid-run moved the headers to `NEEDS YOU 1` + `TODAY 6`, total row count unchanged |
| B1 PINNED precedence | NOT TESTED | the only pinned thread in the host is a child thread, which B9 correctly keeps in its parent's subtree; no pinnable root thread was available without mutating unrelated data |
| B2 date bucketing beyond TODAY | NOT TESTED | the host feeds the slot only TODAY-dated threads (see environment deltas) |
| B9/B10 nesting + chevron collapse, persisted | PASS | collapse/expand cycle above; children render at `padding-left: 20px` under their parent |
| B6 freeze while hovering | NOT TESTED | ran out of budget before a controlled update-under-pointer could be staged; no synthetic path exists that is not "forcing the end state" |
| B43 search flattens the list | PASS | query `slice` → one `RESULTS 8` section, all rows at `padding-left: 8px` (no nesting), project + workspace label on every row; clearing the query restored `TODAY` and 27 rows |
| B26-B30 dossier | PASS | hover renders full title, indicator, Branch, Model (`claude-opus-5[1m] · low`), TIMESTAMPS with absolute created/updated, CONTEXT WINDOW with used/total, TOKENS with total/input/cached input/output/reasoning. No monetary figure anywhere (B30) |
| B31 dossier with no economics | NOT TESTED | no token-less thread is present in the fed list; the single `acp-cursor` thread is not fed to the slot |
| B37-B40 signal glyphs | **FAIL** | see A7 detail |
| B42 bucket-jump shortcuts | PASS | see A8 |
| List states (loading / empty / error / populated) | NOT TESTED | only the populated state occurs against a live host with data; no seam to drive the others without a source change |

---

## Detail on failing and blocked rows

### B46 / A5 — the context menu acts on the wrong thread (Blocker)

**Steps.** Load the list. Compute a point inside a named row and confirm with
`document.elementFromPoint(...).closest("[data-better-sidebar-row]")` that the
point really is over that row. Real right-click at the point
(`mouse move` → `mouse down right` → `mouse up right`). The menu opens. Click
its first item, `Open`. Read `location.pathname`.

**Expected.** The URL ends in the id of the row that was right-clicked.

**Actual**, three runs, three different targets:

| Right-clicked (hit-tested) | Opened |
| --- | --- |
| `thr_iy48ta455u` | `thr_6n8evvuszg` |
| `thr_52yhq4j9h5` | `thr_9sc6kp4svb` (different project) |
| `thr_iy48ta455u` | `thr_9sc6kp4svb` |

Independently: with the menu open on `thr_iy48ta455u`, the row carrying
`data-state="open"` was `thr_9sc6kp4svb`. And choosing `Pin` from a menu opened
on `thr_ubek848wxs` left that thread with `pinnedAt: null` while
`thr_9sc6kp4svb` gained `pinnedAt: 1788103420851` — so the item handlers do
fire; they fire against the wrong `thread.id`.

**Cause (hypothesis, not verified in source).** Only one `ContextMenu.Root`
appears to win the `contextmenu` event for the whole list. `RowContextMenu`
renders one `ContextMenu.Root` per row with `ContextMenu.Trigger asChild`, and
the row's wrapper is also the hover trigger; the digest notes that two nested
`asChild` Radix triggers need one real DOM element between them. The observed
symptom is a single menu instance closing over a stale `thread` prop.

**Recommended fix.** Verify which element the `ContextMenu.Trigger` actually
lands on in the shipped DOM (the row wrapper carries no Radix trigger attribute
at all in the rendered output — only `data-better-sidebar-row` and
`data-state`), and assert in a browser-level test that
`elementFromPoint(row) === the row whose menu opens`. A jsdom test cannot catch
this: `fireEvent.contextMenu` targets the element directly and so can never
observe the wrong root winning.

**Also.** `thr_9sc6kp4svb` is still pinned from this run — the CLI has no unpin
flag and unpinning through the plugin menu would hit a different thread again.
Please unpin it manually.

### A1 — Rename never opens an editor (Blocker)

**Steps.** Real right-click a row, activate `Rename` (tried three ways: text
locator click, raw mouse down/up at the item's center, and
`agent-browser click` on a tagged `[role=menuitem]`). Observe with a
`MutationObserver` installed on `document.documentElement` *before* the action,
logging `document.querySelector("[data-better-sidebar-row] input")` and whether
it holds focus.

**Expected.** `ThreadRow.tsx:225-227` renders the `renameEditor.inputProps`
input; it mounts, stays mounted, and holds focus.

**Actual.** Reproduced twice: `everInput: 0`, `everFocused: 0`, menu closed, no
input anywhere in the list. (One earlier run reported `inputNow: true` — that was
a false positive on the host's hidden `<input type="file">`; the scoped query
returned nothing.)

**Cause.** Downstream of the B46 targeting defect: `onCloseAutoFocus` calls
`renameEditor.start(title)` on the *wrong* row's editor hook, so the row the user
aimed at never enters `isRenaming`. The FocusScope reasoning in
`RowContextMenu.tsx:62-84` is sound and could not be evaluated on its own merits
until targeting is fixed — re-run this row after the B46 fix.

**Recommended fix.** Fix B46 first, then re-test focus ordering.

Related keyboard observation: with the menu open, `ArrowDown` does not move the
highlight (it stays on `Open` after three presses), so the menu appears not to
take keyboard focus either.

### A7 / B37-B40 — the rowSignals batch never fires (High)

**Steps.** Patch `window.fetch` to log every request. Scroll the sidebar's
overflow container to the top, then to `scrollHeight`, changing the visible set
completely. Read the log.

**Expected.** Per TECH §7's B37-B40 re-wording, an `IntersectionObserver` on
mounted rows issues a batched `rowSignals` request for the newly visible ids.

**Actual.** 30 requests captured, none of them the plugin's. Other plugins'
per-thread RPCs fire in the same window
(`/api/v1/plugins/message-timestamps/rpc/userMessageTimes` with a `threadIds`
body), so the fetch hook is proven live. All 27 `[data-better-sidebar-signals]`
spans are empty (`innerHTML.length === 0`) before and after the scroll.

**Consequence.** Context pressure, model fallback, rate-limit and goal glyphs can
never render. This also means the empty-span measurement that B51.5 passes on is
passing for the wrong reason — it is empty because nothing ever populates it.

**Recommended fix.** Check `useRowSignals.ts:121`'s ordering assumption: the
observer's first callback is expected only *after* the passive effect installs
the RPC function. If the callback lands first with a null RPC and the observer is
never re-triggered (rows stay mounted, so no new `observe` call arrives), the
fetch is dropped permanently. A browser-level test must assert the request goes
out, not that the observer was constructed.

### B45 — rows do not drag out to a split (High)

**Steps.** `mouse down` on a row at (90, 437), four `mouse move` steps out to
(800, 450) over the main area, `mouse up`.

**Expected.** A second pane appears carrying that thread.

**Actual.** The drag was treated as a click: the current pane navigated to
`thr_ubek848wxs`, no second pane. Inspecting every element of a row, no
drag-related attribute is present anywhere — no `draggable`, no
`aria-roledescription`, no dnd-kit `data-*`. bb's own list announces
"To pick up a draggable item, press the space bar", so the host uses dnd-kit and
expects those attributes on the draggable node.

**Cause (hypothesis).** `splitProps` is destructured at `ThreadRow.tsx:104` and
spread at `:185`, but nothing from it survives into the DOM — either the hook
returns an empty object at runtime, or the spread lands on a node React drops the
props from. The digest records that the test harness deliberately reports empty
`splitProps`, so the unit test asserting the spread cannot detect an empty one.

**Recommended fix.** Log what `useSidebarThreadSplit(thread.id)` actually returns
in the browser, then assert at least one of its keys reaches the rendered
element.

### B55.3 / B55.4 — phone-width rows BLOCKED (environmental)

`agent-browser set viewport 390 844` resizes the window, but the page continues
to match `(min-width: 768px)` and the host keeps the sidebar panel at
`visibility: hidden; left: -320px`. Clicking the `aria-label^="Toggle sidebar"`
control flips its `aria-expanded` but the panel never enters the viewport; a
bounded wait for `getBoundingClientRect().left >= 0` timed out at 25s. All
geometry rows above were therefore measured on the off-screen panel — valid
numbers in the panel's own 320px coordinate space, labelled translated evidence,
but `isCompactViewport` was never true, so B32/B55.3 and the tap-target row
B55.4 are untested.

**To unblock.** Drive the phone case through a real device-emulation profile
(`agent-browser -p ios`, or a Playwright context with `isMobile: true`) so the
media query and the drawer both behave, or reproduce on the user's own
`mksn.getbb.app` session.

---

## Visual fidelity — frontend-design Review checklist

Target surface: `src/row/`, `src/ui/ListStates.tsx`, `src/ThreadList.tsx`,
`src/dossier/Dossier.tsx`. Landing-only categories (Hero, Layout rhythm, Assets)
do not apply to a sidebar list.

| Category | Verdict |
| --- | --- |
| Navigation | Pass — the list is the navigation; the active thread is carried by the host's row highlight, section headers are one line, no height creep |
| Actions and CTAs | Pass — every context-menu label fits one line; labels name outcomes (`Open in split`, `Mark unread`, `Delete…`) and toggle correctly against state (`Pin`/`Unpin`) |
| Forms | Not applicable — the only input is the rename editor, which never rendered |
| States | **Fail** — the four list states exist in `ListStates.tsx` but only the populated state was reachable, and the signal cluster has a permanently empty state it should not have (A7) |
| Copy | Pass — dossier section labels (`TIMESTAMPS`, `CONTEXT WINDOW (ESTIMATED)`, `TOKENS`) and menu labels are plain and consistent; no em or en dashes in any rendered string; `CONTEXT WINDOW (ESTIMATED)` honestly labels its estimate |
| Visual consistency | Pass — one radius scale (`rounded-md` on rows, `rounded-lg` on the popover, matching bb's own popovers), one neutral ramp, glyphs are one inline-SVG family at `size-3`/`size-3.5`, colour appears only on the provider tint and the two Needs-you states as B22 requires |

No Critical or Major visual finding. The `Fail` above is the functional A7
defect surfacing as a state gap, not a styling issue.

---

## Human verification

- Light-theme provider glyph rendering (A9), through bb's own theme switch rather
  than a forced class.
- Every phone-width row, on the user's real `mksn.getbb.app` / Brave Android
  session.
- The PR chip and its hover card (B33-B36, A4), on a host that has a thread with
  an open pull request.
- Unpin `thr_9sc6kp4svb`, pinned by the defective context menu during this run.

## Counts

Pass 20 · Fail 5 · Blocked 2 · Paper cut 1 · Not tested 8

---

## Post-fix re-test (debug wave, 2026-08-30)

Re-run of the four defects in a real browser against a **clean rebuild of HEAD
source** (`bb plugin build .` + `bb plugin reload better-sidebar`, then
`location.reload(true)`), 29 `[data-better-sidebar-row]` nodes confirmed each
time. No source change was needed for any of them; the source is unchanged from
`83214d4`.

Method note that invalidates part of the original run: the list's scroll
container ends at `y = 529` in this window, while `getBoundingClientRect()`
reports un-clipped positions. Points computed for rows below that line are not
over the row at all - `document.elementFromPoint` returns nothing there, and a
synthesised mouse event at an out-of-viewport coordinate lands somewhere else.
Two rows in this re-test (`thr_kz9bh6hjdn`, `thr_7h8mumntcv`) reproduced the
original "menu acts on another row" shape for exactly that reason.

### B46 / A5 - context menu targeting: NOT REPRODUCED

Four rows, each hit-tested inside the scroll viewport first, real right-click
(`move` -> `down right` -> `up right`), then `Open` clicked and
`location.pathname` read:

| Aimed at | `data-state="open"` | Navigated to |
| --- | --- | --- |
| `thr_e8kq8y95af` | `thr_e8kq8y95af` | `.../thr_e8kq8y95af` |
| `thr_ubek848wxs` | `thr_ubek848wxs` | `.../thr_ubek848wxs` |
| `thr_52yhq4j9h5` | `thr_52yhq4j9h5` | `.../thr_52yhq4j9h5` |
| `thr_47nu4g4826` | `thr_47nu4g4826` | `.../thr_47nu4g4826` |

Row geometry was also checked directly: 29 rows, zero nesting, zero overlap, and
the row order is stable under a parked pointer over a 10s sample.

### A1 - Rename: NOT REPRODUCED (and not downstream of B46)

`MutationObserver` armed on `document.documentElement` before the action.
Right-click `thr_n3v6acmnj2` -> `Rename`: `everInput: 2`, `everFocused: 2`,
`document.activeElement` is the input, `aria-label="Rename thread"`, seeded with
that row's own title. Escape cancelled it; the title is unchanged. No thread was
mutated.

### A7 / B37-B40 - rowSignals: NOT REPRODUCED

After the rebuild a scroll of the list issues
`POST /api/v1/plugins/better-sidebar/rpc/rowSignals` -> `200`. The spans are
empty because the data says so, not because the batch is dead: every thread
returns `contextPressure` below the 0.8 threshold with `modelFallback: null`,
`isRateLimitPaused: false`, `goal: null`.

Render path proved end-to-end by intercepting the RPC response with
`contextPressure: 0.93, isRateLimitPaused: true`: the row drew
`[data-signal="context-pressure"]` and `[data-signal="rate-limit-paused"]`.
So observer -> batch -> RPC -> cache -> glyph all work in the browser.

### B45 - drag to split: REPRODUCED, cause is host-side

The original diagnosis is wrong on both counts. `PluginSidebarThreadSplit.splitProps`
is typed `{ onPointerDown?: (e) => void }` - a React handler, which never appears
as a DOM attribute, so "no drag attribute in the row's DOM" proves nothing.

Instrumented in the browser, the row's contract is fully satisfied:

- `useSidebarThreadSplit(thread.id)` returns `isAvailable: true` and
  `splitProps` with `onPointerDown` of type `function`, on every row.
- During a real drag the host's `onPointerDown` **is invoked** (counter: 1).
- The row's own `openThread()` is **not** called (counter: 0), so the navigation
  that follows is the host's own drop resolution, not a click leaking through.

The native anchor drag was also ruled out: `a.draggable` is `true` and
`dragstart` fires, but suppressing it (`a.draggable = false`, `dragstart` count
0) changes nothing - still a replace, no split. Tested with a pane already open
and with drops at x=1100 and x=1272 (far right edge) at 1280x800.

Everything the plugin owns is correct; the split-vs-replace decision belongs to
bb's gesture engine. This may also be intended behaviour under the documented
"pane cap coerces a split into a replace" rule. Not fixable from
`plugins/better-sidebar/src/**`.

### Suite

`npx vitest run` outside `src/header/`: 22 files, 237 tests, all passing.
`npx tsc --noEmit` reports nothing outside `src/header/`. The 12 failures and
all TS errors in the full run come from the sibling seat's uncommitted
`src/header/ChildThreadsChip.test.tsx` (jest-dom matchers not registered), which
is outside this wave's boundaries.

---

## Orchestrator control test — B45 is NOT-TESTABLE, not FAIL

The fix seat proved every row-side obligation is met and concluded the
split-vs-replace decision belongs to bb's gesture engine. I ran the control
that settles it: **the same hit-tested synthetic drag against bb's own
built-in thread list**, on the same build, viewport and coordinates.

- Switched the provider preference to `__builtin__` and hard-reloaded;
  confirmed 12 built-in shortcut targets and zero plugin rows.
- Hit-tested the start point against `elementFromPoint` before using it, so the
  press landed on a live row inside the scroll viewport's clip
  (`160,460` → `thr_6n8evvuszg`).
- Dragged out through four intermediate points to `1268,400`, the far right
  edge of the main area, and released.

**Result: no split, and the URL did not change — identical to the plugin's
list.** bb's own rows do not split under a synthesised pointer drag either.

So the harness cannot drive this gesture on any list, and B45's original
**FAIL is withdrawn and replaced with NOT-TESTABLE**. The plugin spreads
`splitProps` onto the anchor, the host's `onPointerDown` is verifiably invoked,
and no row-side obligation is unmet. Confirming real drag-to-split needs a human
with a real pointer, or a harness whose synthetic events satisfy the host's
gesture recogniser.

## Verdict correction

The original **FAIL** rested on four defects. Three were artifacts of this QA
run's own method:

| Row | Original | Corrected | Cause of the false positive |
| --- | --- | --- | --- |
| B46/A5 menu targeting | FAIL (Blocker) | **PASS** | click points taken from `getBoundingClientRect` without hit-testing, so they landed outside the scroll viewport's clip and were clamped onto another row |
| A1 rename | FAIL (Blocker) | **PASS** | same clamping; not downstream of B46 — it works independently |
| A7/B37-B40 row signals | FAIL (High) | **PASS** | the QA run tested a stale bundle; after `bb plugin build .` the batch fires and returns 200 |
| B45 drag to split | FAIL (High) | **NOT-TESTABLE** | see the control test above |

**The stale bundle is my defect, not QA's.** The QA packet said *"Do not run
`bb plugin install`, `build`, or `reload` — the plugin is already running and
rebuilding it mid-QA invalidates everything you measured."* That instruction
optimised for measurement stability and bought a whole run against stale code.
The correct rule is: **build and reload once, up front, then hold the build
frozen for the rest of the run.**

The second lesson is QA's: **hit-test every synthetic coordinate against the
scroll container's clip before clicking**, never trust `getBoundingClientRect`
alone inside a scrollable list.
