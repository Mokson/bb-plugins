# PRODUCT — Better Sidebar

A bb sidebar thread-list replacement organised by **activity date** rather than by
project, with a second metadata row, provider logos, five-state status glyphs, and a
hover dossier.

Registered via `app.slots.experimental_threadList`. Plugin id `better-sidebar`,
picker title **Better Sidebar**.

---

## 1. Sections and ordering

Sections render top to bottom. **Every thread appears exactly once**, assigned by
strict precedence:

```
NEEDS YOU   ← thread.hasPendingInteraction === true
PINNED      ← thread.isPinned === true (and not Needs-you)
TODAY / YESTERDAY / LAST 7 DAYS / LAST 30 DAYS / OLDER
```

- **B1** (auto) A thread satisfying two section predicates renders only in the
  highest-precedence one. No thread id appears twice in the rendered list.
- **B2** (auto) Date buckets are computed from `latestAttentionAt` against local
  calendar days. `TODAY` = same local calendar day as now; `YESTERDAY` = the
  previous local calendar day; `LAST 7 DAYS` = older than yesterday, within 7×24h;
  `LAST 30 DAYS` = within 30×24h; `OLDER` = everything else.
- **B3** (auto) Buckets recompute on a timer, not only on data change, so a list
  left open across local midnight re-partitions without a reload.
- **B4** (auto) An empty section renders nothing — no header, no placeholder.
- **B5** (auto) Within every section, threads sort by `latestAttentionAt`
  descending.
- **B6** (manual) While the pointer is over the list, re-ordering is frozen: the
  rendered order does not change even as `latestAttentionAt` updates. The frozen
  order releases on pointer-leave, or after 2s of pointer idle outside the list.
  New threads that arrive while frozen append at their sorted position on release.
- **B7** (auto) Date buckets are collapsible with a persisted per-install state,
  and each header shows the count of threads it contains. `NEEDS YOU` and `PINNED`
  are not collapsible.

### Grouping modes

- **B8** (auto) `groupBy: "date"` (default) produces the sections above.
  `groupBy: "project"` replaces the date buckets with one section per project,
  keeping `NEEDS YOU` and `PINNED` above. `groupBy: "none"` produces one flat
  section, `NEEDS YOU` and `PINNED` still above.

---

## 2. Child threads

- **B9** (auto) A thread with `parentThreadId` renders nested beneath its parent
  with a depth indent, never as a sibling in its own bucket. The parent's section
  assignment wins for the whole subtree.
- **B10** (auto) A parent with children shows a chevron with the child count; the
  chevron collapses/expands the subtree, persisted per install.
- **B11** (auto) `isArchived` threads are hidden unless they are children of an
  expanded parent.
- **B12** (auto) A child row shows its own relative time on row 2, so a recent
  child under an old parent is visibly recent.

---

## 3. Row anatomy

**Row 1**: `[chevron+count when children] · title · [state glyph]`

- **B13** (auto) Title is `title ?? titleFallback ?? "Untitled"`.
- **B14** (auto) `isUnread` is carried by font weight only — never opacity, never a
  separate dot. A resting row is never faded.
- **B15** (auto) No pin glyph is drawn; the `PINNED` section conveys it.

**Row 2**: `project · workspace · ⟨spacer⟩ · relative time · PR chip · provider glyph`

- **B16** (auto) Workspace label resolves `environment.branchName` →
  worktree name → `host.name` → omitted, in that order.
- **B17** (auto) The provider glyph always renders, so row 2 has a fixed right
  edge even when a thread has no branch and no PR.
- **B18** (auto) `secondRow: "auto"` (default) shows row 2 in `date` and `none`
  modes and hides it in `project` mode; `"always"` and `"never"` override.
- **B19** (auto) On `isCompactViewport`, row 2 still renders.

---

## 4. State glyphs — five states

Monochrome, `size-3.5`, fixed-width trailing slot. **No row tint, no filled badge,
no coloured row background.**

| State | `indicator` values | Treatment |
| --- | --- | --- |
| Needs you | `waiting-for-input` | amber |
| Needs you (error) | `unread-error` | red |
| Working | `runtime`, `workflow`, `background-agent`, `background-command` | muted foreground + slow pulse |
| Planning | `plan-mode`, `goal` | muted foreground |
| Draft | `draft`, `working-draft` | muted foreground |
| Unread | `unread-success` | muted foreground dot |
| Idle | `none` | nothing drawn |

- **B20** (auto) An `indicator` value outside the enumerated set draws nothing and
  throws nothing. bb adds kinds over time; a future kind must not break the list.
- **B21** (auto) The glyph carries `aria-label={thread.indicatorLabel}` so
  screen-reader text matches bb's own.
- **B22** (auto) Colour is used **only** for Needs-you and error. Working is
  distinguished by motion, not hue.

---

## 5. Provider glyph

- **B23** (auto) Resolved from `experimental_useProviders()`; the provider's
  `logoUrl` is applied as a CSS mask and filled with `strings.iconTint.light` /
  `.dark` per theme.
- **B24** (auto) A provider with no served logo, or one absent from the directory,
  renders a neutral dot — never nothing, never a broken image. Provider ids are
  plugin-contributed (`acp-*`), so no hardcoded id map may exist.
- **B25** (auto) The glyph carries the provider's `displayName` as its accessible
  name, falling back to the raw `providerId`.

---

## 6. Hover dossier

- **B26** (manual) Triggered by hovering the row, after ~250ms. Suppressed while
  any pointer button is down and for 300ms after release, so it never appears
  during a split-drag or while aiming at the context menu.
- **B27** (manual) Opens immediately with data already in the sidebar cache; the
  backend fields stream in without the popover waiting on the network.
- **B28** (auto) Backend data is fetched lazily at ~200ms hover-intent, cached with
  a short TTL, and invalidated by the `thread/tokenUsage/updated` realtime channel.
  Hovering N rows issues at most N requests, never a batch on mount.
- **B29** (auto) Contents: full title · exact `indicator` and non-zero `activity`
  counts · model · reasoning effort · absolute `createdAt`/`updatedAt` ·
  context-window bar · token breakdown (total, input, cached input, output,
  reasoning).
- **B30** (auto) **No monetary cost figure anywhere.** bb exposes no per-thread
  cost; the plugin never estimates one.
- **B31** (auto) When a thread has no token data (its provider reports none), the
  entire economics section is omitted — never zeros, never dashes. The rest of the
  dossier still renders.
- **B32** (auto) On `isCompactViewport` the dossier does not render at all. No
  long-press substitute.

---

## 7. Pull request chip

- **B33** (auto) Renders on row 2, left of the provider glyph, as an icon plus
  `#<number>`, from `experimental_useSidebarThreadPullRequest`.
- **B34** (auto) Tinted by `attention`: merged tone for `state === "merged"`;
  destructive for `checks_failed` and `conflicts`; success for `ready_to_merge`;
  muted otherwise.
- **B35** (manual) Its own hover card — not a native `title` — showing PR title,
  state, and the attention reason in words ("Checks failed", "Changes requested").
- **B36** (auto) Clicking opens the PR URL in a new tab and does not navigate the
  thread (`stopPropagation`). On `isCompactViewport` it remains a plain tappable
  link with no hover card.

---

## 8. Extra signals

- **B37** (auto) **Context pressure**: a row whose `contextWindowUsage` exceeds 80%
  shows a warning glyph. Absent when no context data exists.
- **B38** (auto) **Model fallback**: a thread with a `provider/modelFallback` event
  shows an alert glyph; the dossier names `originalModel`, `fallbackModel`, and the
  reason.
- **B39** (auto) **Rate-limit paused**: a thread parked on a provider rate limit
  renders as its own state, distinct from idle.
- **B40** (auto) **Goal ring**: a thread with an active goal shows a progress ring
  from `tokensUsed / tokenBudget`; `budgetLimited` status renders as full.
- **B41** (auto) **Stale dimming**: an opacity gradient across buckets — `TODAY`
  full, each older bucket progressively dimmer, floored so `OLDER` stays legible.
- **B42** (manual) **Bucket-jump shortcuts**: keyboard navigation between section
  headers, chosen so they do not collide with bb's nine existing sidebar shortcuts.

---

## 9. Host contract — non-negotiable

- **B43** (auto) The list filters by the `searchQuery` prop. When it is non-empty,
  **all grouping is suspended**: one flat list ranked by match then
  `latestAttentionAt`, with the project label on every row. Buckets return when the
  query clears.
- **B44** (auto) Every row's interactive element carries
  `data-sidebar-thread-shortcut-target=""` and `data-sidebar-thread-id={id}`, in
  visual order, so bb's nine numbered/next/previous shortcuts keep working.
- **B45** (auto) Every row spreads `splitProps` from
  `experimental_useSidebarThreadSplit`, so rows drag out to split panes.
- **B46** (manual) Right-click opens a context menu offering: open, open in split,
  pin/unpin, mark read/unread, rename, archive, request delete, and open pull
  request when one exists. Delete routes to `requestDelete` — the host owns the
  confirmation.
- **B47** (auto) `onNavigate()` is called after every thread open, so the mobile
  drawer closes and the host search field clears.

---

## 10. Settings

Exactly three, via `bb.settings.define`:

- **B48** (auto) `groupBy`: `date` (default) | `project` | `none`.
- **B49** (auto) `secondRow`: `auto` (default) | `always` | `never`.
- **B50** (auto) `tooltip`: `rich` (default) | `minimal` | `off`. `minimal` shows
  the overflow fields only (full title, full branch, absolute time) with no backend
  fetch; `off` disables the dossier entirely.

---

## 11. Out of scope

Manual drag-to-reorder · snooze/settle shelves · project favicons · search-result
snippets · per-thread cost estimation · any persisted per-thread plugin state
beyond collapse and bucket-collapse.
