# Spec review arbitration

Orchestrator rulings on `REVIEW-SPECS.md` (GPT-5.6-Sol, cross-vendor, 7 BLOCKER /
6 MAJOR / 1 MINOR). Every finding is **accepted**; none was refuted. The rulings
below are binding on the TECH.md revision. PRODUCT.md is still not edited — §7 stays
the single home for invariant re-wordings.

## BLOCKERs

**1. Hidden dossier integration file — accepted.**
Slice 4 gains `src/dossier/RowHover.tsx`, a wrapper with the fixed signature
`({threadId, children}) => ReactNode`. Slice 3's `ThreadRow` renders its content
inside it. Same seam pattern as `RowSignals` and `RowContextMenu`, so no slice edits
another's file.

**2. Windowing breaks the host shortcut contract — accepted; drop the windowing.**
B44 was a user-declared non-negotiable. Probed and confirmed: **neither reference
plugin windows its list** — `bb-sidebar` (12,456 lines) and `t3sidebar` both render
every row. Windowing was premature optimisation bought at the price of a
non-negotiable.
Ruling: **§6 windowing is removed. Every row mounts, always, in visual order.**
Retained mitigations: the PR hook is gated behind `environment !== null`, and rows are
`React.memo`'d on the fields they read. The `≤60 rows` test is replaced by
`200 threads → 200 shortcut targets, in order`.
Consequence for B37-B40: the batch is no longer over "windowed ids" but over
**viewport-visible ids**, collected with an `IntersectionObserver`. Rows stay mounted;
only the signal *fetch* is bounded. Re-word the §7 B37-B40 correction accordingly.

**3. Rename has no input path — accepted.**
`actions.rename(threadId, title)` is silent by design. The menu item opens an **inline
rename editor in the row**, the pattern `bb-tinted-threads` already uses: Enter
commits via `actions.rename`, Escape cancels, blur commits.
Ownership: slice 6 owns `src/menu/useRenameEditor.ts` (state + handlers, fixed
signature); slice 3's `ThreadRow` renders the input when `isRenaming` is true. No
shared file.

**4. Context-menu opens cannot satisfy B47 — accepted.**
`RowContextMenu`'s fixed signature becomes
`{thread, pullRequest, onNavigate, renameEditor}`. `onNavigate` comes from slot props
through `ThreadList` → `ThreadRow` → menu. Every menu path that opens a thread calls
it.

**5. PR URL cannot reach the menu — accepted.**
Move the hook up exactly one level: `ThreadRow` calls
`experimental_useSidebarThreadPullRequest(thread.id)` **once** and passes the result
as a prop to both `PrChip` and `RowContextMenu`. `PrChip` becomes purely
presentational. This is one hook per row, not two, and it also makes `PrChip`
testable without a host.

**6. `openUrl` does not promise a new tab — accepted.**
§7 gains a B36 ruling: *"Clicking opens the PR through the host's `openUrl`, which
honours the client's own browser preference rather than guaranteeing a new tab; it
never navigates the thread. A falsy return surfaces as a toast."* Fix the test to
assert `openUrl` was called and no `open` entry appeared in `sidebarActionCalls`.

**7. Shortcut collision test is vacuous — accepted.**
Effective bindings are user-configurable server-side, so no test can prove
collision-freedom against them. Ruling: **choose bindings that cannot collide by
construction** — modifier-qualified only (`Alt+ArrowUp` / `Alt+ArrowDown` for section
jump, the same modifier idiom `bb-tinted-threads` uses for row reorder). The test
asserts every entry in the table is modifier-qualified and that the table contains no
bare alphanumeric key. §7 records that a user who deliberately rebinds a host command
onto `Alt+Arrow` can still collide, and that this is out of the plugin's control.

## MAJORs

**8. The freeze correction still moves rows — accepted.**
Per-section append shifts every row in lower sections when the top section grows.
Ruling: **freeze the whole rendered sequence, not per section.** While frozen, a
newly arriving thread is appended to the **end of the entire list** in arrival order,
visually unseparated; nothing above it moves, by construction. On release it takes its
sorted position. Rewrite §4's state machine and the §7 B6 ruling to match, and add the
test: a new `needs-you` thread arriving while frozen changes no existing row's index.

**9. Combined `limit: 25` erases durable signals — accepted.**
One overall limit across five event types loses older-but-still-current signals.
Ruling: **one `events.list` call per event type, each with its own small limit** — the
signals only ever need the latest of each type. State the resulting call count per
thread explicitly, and cap the batch accordingly.

**10. RPC failure mistaken for nullable data — accepted.**
A rejected call is not a null field. Ruling: the dossier hook carries an explicit
`status: "idle" | "loading" | "ready" | "error"`, retries once, and renders an inline
error line — never an indefinite spinner. Add the test: a rejecting `threadDossier`
renders the error line and no spinner.

**11. Loading, failure and empty states undefined — accepted, and this is the one
most likely to be seen by a real user.**
`experimental_useSidebarThreads()` has `status: loading | error | ready`. Ruling:
slice 2 owns four explicit branches with four tests — **loading** (skeleton rows),
**error** (inline message plus a retry affordance), **empty** (no threads at all, with
a New-thread hint), and **no search matches** (distinct copy naming the query). A
blank sidebar is never an acceptable rendering of any of them.

**12. Declared dependency graph is not the import graph — accepted.**
Ruling: state the TRUE graph. `ThreadList` imports `ThreadRow`; `ThreadRow` imports
`RowHover`, `RowSignals` and `RowContextMenu`. So the real compile order is
`1, 5 → 4, 6 → 3 → 2`, not `1, 5 → 2 → 3, 4, 6`. Correct §8's graph and every slice's
`Blocked by`. The "write against the signature, fail `tsc` until it lands" property is
unchanged and still the intended cheap signal — only the stated order was wrong.

**13. B13 and B16 assigned to a slice that renders nothing — accepted.**
Ruling: keep them in slice 1 by making them real model outputs. `RenderRow` carries
resolved `title: string` and `workspaceLabel: string | null` fields, computed by the
pure model. Slice 1 tests the resolution (including `environment: null`); slice 3 only
renders the strings. This keeps the logic where tests are cheapest and removes the
mismatch.

## MINOR

**14. Manual-test count wrong — accepted.** Six manual invariants, not five:
B6, B26, B27, B35, B42, B46.

## Simpler-approach question — adopted

Collapse state is a client-local preference, and `bb-sidebar` persists exactly this
kind of state in `localStorage`. Ruling: **drop `readCollapse` / `setCollapse`, the kv
store, and `COLLAPSE_CHANNEL`.** Collapse (both bucket and parent-thread) moves to a
namespaced, schema-validated `localStorage` helper owned by slice 2. This deletes an
RPC pair, a kv table, a realtime channel, and their tests, and it removes slice 2's
dependency on slice 5 entirely.
