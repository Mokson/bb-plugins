# Code review arbitration

Two seats, both `block`:
- `review-crossvendor.json` — GPT-5.6-Sol, whole diff, traced bb's real host source.
- `review-scrutinize.json` — Opus, architecture and seams.

They independently found the same freeze defect, which is why it is treated as
confirmed rather than plausible. Every finding below is **accepted**; none was
refuted. Two fixer waves, disjoint boundaries.

## Confirmed by orchestrator

**F1 — B44 is completely broken. BLOCKER.**
I verified this myself against the compiled host at
`/Applications/bb.app/.../bb-app/app/dist/assets/index-CUMoMqjq.js`. The collector:

```js
for (const el of matches) {
  if (el instanceof HTMLAnchorElement) { /* push target */ }
  else { if (!el.getAttribute("data-sidebar-windowed-nav")) continue; /* ... */ }
}
```

A `<div>` carrying `data-sidebar-thread-shortcut-target` is **rejected**. Our rows
are `<div role="button">`, so the host returns zero targets and all nine numbered /
next / previous shortcuts do nothing. bb's own row is an `<a>` with
`className="absolute inset-0"` — a click overlay covering the row, which is also what
the `thread-provider-icons` plugin's source comment describes.

210 tests passed through this because every one of them asserts the *attributes*
exist. Attribute presence was never the contract; being an anchor is.

## Wave A — model, freeze, backend

**F2 — expand-while-frozen appends rows to the end of the list. BLOCKER.**
Found by both seats. Collapse a subtree, hover the list (which is the only way to
reach the chevron, so the freeze is always engaged), expand: the children are absent
from `frozen.ids`, so `applyFreeze` classifies them as newcomers and appends them
under a foreign header at the bottom. §4 deliberately makes collapse a
non-invalidator, so this fires on *every* expand.

**F3 — a collapsed section vanishes while frozen. MAJOR.** Same root cause.

**Root cause and the required shape of the fix.** `applyFreeze` rebuilds section and
tree structure from a row-only snapshot. That is the error class; F2 and F3 are two
of its instances and more exist. Per the cross-vendor seat's own simplification note:
**preserve the live section metadata and overlay only the frozen global id order.**
A fix that special-cases expansion is a re-tune and will be rejected.

**F4 — a parent cycle makes both threads disappear entirely. MAJOR.** `A.parent = B`,
`B.parent = A`: neither enters `roots`, so neither renders anywhere. B1 says every
thread appears exactly once.

**F5 — B13 trims whitespace-only titles. MINOR.** `title: "   "` with a
`titleFallback` shows the fallback; B13's chain is nullish, not truthy.

**F6 — the freeze tests are self-referential. This is why F2 shipped.**
`list-model.test.ts:368` defines `freezeOf()`, a hand-copied reimplementation of
`useFreeze.ts:115`'s `snapshot()`. Every freeze-overlay test builds its input from
the copy, so the machine and the transform are only ever tested against each other's
stand-ins and can diverge freely. **No test anywhere feeds a real `useFreeze`
snapshot into `buildListModel`.** Delete the copy; make at least one test drive the
real machine into the real overlay.

**F7 — delete the "no frozen row survives" fallback** (`list-model.ts:323-328`). It
re-appends live sections after dropping them, producing a hybrid order no requirement
asks for. Releasing the freeze is the correct response to an empty snapshot.

**F8 — `thread.active` invalidates at the START of a turn. MINOR.** No new usage data
exists then; §7's ruling names `thread.idle` as the moment it lands. Doubles the
refetch of every visible row's signals per turn.

**F9 — delete the backend `TtlCache`** (`server.ts:18-45`, `:152-153`). The frontend
already caches at the same TTLs with in-flight dedup, so it absorbs nothing for a
single client while adding a second invalidation surface that can disagree with the
first. Two cache-hit tests (`server.test.ts:172`, `:229`) assert the cache rather than
the payload and go with it.

## Wave B — row, dossier, menu, list shell

**F1 (above) — make the row's interactive element an anchor.** Follow bb's own
pattern: a relative row container with an `absolute inset-0` `<a>` overlay carrying
both data attributes, the click handler, and `splitProps`. The row's content sits
above it. Keep the 200-row guard test and **strengthen it to assert the targets are
anchors**, not merely present.

**F10 — the dossier flips to a permanent skeleton. MAJOR.** A ready dossier that ages
past its 10s TTL while the popover is open re-evaluates to `loading` on any re-render
(the `useNow` minute tick will do it), and nothing re-triggers the fetch because the
effect's deps did not change. The test at `useDossier.test.tsx:163` disables the hook
before advancing the clock — the one ordering that avoids the bug.

**F11 — row signals disappear after 30s and never return. MAJOR.** `runBatch` is only
reachable from an IntersectionObserver callback or a realtime message, so a
stationary viewport never refreshes and the glyphs simply vanish.

**F12 — `openUrl`'s result is ignored in the menu. MAJOR.** Found by both seats.
B36's ruling is implemented twice, divergently: the chip toasts on refusal, the menu
discards it. One shared handler passed as a prop; two call sites for one host
contract is the defect.

**F13 — `tooltip: "minimal"` still hits the backend. MAJOR.** B50 says minimal shows
overflow fields only with no backend fetch; `RowHover` enables `useDossier` anyway
and issues three SDK reads per hover.

**F14 — the minimal dossier omits the full branch. MAJOR.** It renders indicator,
activity and timestamps but not the branch — the single most useful overflow field,
since row 2 truncates it.

**F15 — the Retry control is unreachable. MAJOR.** Leaving the row clears hover state
and Radix unmounts the card before the pointer arrives at the button. An error state
with an unreachable retry is not an error state.

**F16 — widen `RowHover` to take the `RenderRow`.** The `{threadId, children}`
signature existed so slice 4 would never edit slice 3's file — ownership, not
cohesion. Because it admits only an id, `Dossier.tsx` re-subscribes to the entire
thread list, linear-scans it, and re-implements `resolveTitle` — exactly the
re-derivation ruling 13 removed. Passing `row` deletes `CompactViewportContext`,
`CompactViewportProvider`, `COMPACT_QUERY`, `matchCompact`, `subscribeToCompact`,
`useIsCompactViewport`, a `useSyncExternalStore` per row, the second subscription,
the scan, and the duplicate title resolver. **~80 lines, and it also fixes F13/F14
cheaply**, because the row's data is then already in hand.

**F17 — a collapsed section header is fully opaque. MINOR.** It derives `dimLevel`
from `rows[0]`, which is absent when collapsed.

**F18 — rename seeds from raw `thread.title`. MINOR.** A thread showing its
`titleFallback` opens the editor empty. Use the model's resolved `row.title`.

## Deferred, with reasons

- **`useRenameEditor` as a per-row hook** (scrutinize): 200 rows mount 200 copies of a
  two-field state machine when at most one can be renaming. Real, and a genuine
  consequence of ruling 3's ownership split — but it is a refactor with no user-visible
  defect, and wave B is already large. Filed, not fixed.
- **Module-level caches surviving an in-place plugin reload** (both seats): real, but
  the blast radius is a stale entry after a developer reload, not a user-facing
  defect. Filed.
- **`ensureObserver` throws from a ref callback** when `IntersectionObserver` is
  absent, blanking the sidebar: fold into wave B only if cheap — degrade to "no
  signals" instead of throwing. It is a one-line `try`.
- **`bucketJump`'s `modifiers` table** asserting a constant it also defines: style,
  filed.

## Untestable runtime assumptions → QA

Nine assumptions about Radix and DOM runtime behaviour that jsdom **cannot** prove
(focus ordering, portal dismissal, pointer-event ownership across nested triggers,
CSS mask rendering, IntersectionObserver inside the sidebar's overflow container).
One of this class already shipped broken and needed a fix wave. They are listed in
`review-crossvendor.json` under `untestable_runtime_assumptions` and are **mandatory
QA rows in a real browser**, not review items.
