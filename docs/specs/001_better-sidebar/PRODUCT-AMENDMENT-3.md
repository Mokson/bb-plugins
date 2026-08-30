# PRODUCT amendment 3 — the settings surface

Settled with the user across four interview rounds. **Supersedes B18/B49
(`secondRow`) and B50 (`tooltip`)**, which are removed and replaced by `density`.
Invariants continue from B59.

## The bar that produced this

Round 8 of the original interview capped this plugin at three settings, on the
argument that each one is a branch maintained and tested forever. That argument
stands. What changed is evidence: the user made eight layout decisions this session by
looking at the plugin on a phone, and some of those turned out to be **contested by
context** rather than simply right or wrong.

So the bar is: **a setting exists only for what genuinely varies by context** —
viewport, project count, whether you work in PRs, how many agents you run. Every layout
decision made this session (chevron placement, counters, left inset, trailing spacing)
was decided *decisively* once seen, and stays opinionated. Audience is **the user
first, marketplace second**: anything a stranger would need explained is a README line,
not a setting.

## B59 — seven settings

| Key | Type | Default | What it answers |
| --- | --- | --- | --- |
| `groupBy` | select `date` \| `project` \| `none` | `date` | how is the list organised |
| `density` | select `compact` \| `default` \| `detailed` | `default` | how much is shown |
| `showPrChip` | boolean | `true` | do I work in pull requests |
| `showProviderGlyph` | boolean | `true` | do I run more than one agent |
| `showRelativeTime` | boolean | `true` | do I want per-row times |
| `showArchivedChildren` | boolean | `true` | do archived children show under an expanded parent (B11) |
| `showHeaderChip` | boolean | `true` | does the child-threads chip occupy bb's header row (B58) |

- **B59.1** (auto) All seven are **server-backed** through `bb.settings.define`, so they
  follow the user across every client on this bb.
- **B59.2** (auto) Unknown, missing or wrong-typed values fall back to the default
  without throwing — `parseSettings` already guarantees this and must keep doing so as
  the surface grows.

## B60 — what `density` means

`density` replaces `secondRow` **and** `tooltip`; both were already asking "how much do
I want shown", and three knobs on one axis is worse than one.

| | `compact` | `default` | `detailed` |
| --- | --- | --- | --- |
| row 2 on roots | never | in `date` and `none` modes | in **every** mode |
| row 2 on children | never (B52) | never (B52) | never (B52) |
| hover card | **none at all** | rich dossier | rich dossier |
| signal glyphs (B37-B40) | none | none | all |
| backend fetch | **never** | on hover intent | on hover intent + row signals |

- **B60.1** (auto) `compact` performs **no backend RPC of any kind** — no dossier
  fetch, no row-signal batch, no `IntersectionObserver` mounted. This preserves the
  behavioural guarantee the old `tooltip: "off"` carried (B50), under a new name.
- **B60.2** (auto) `detailed` is the only level that mounts the signal observer.

> **Compression flagged for veto.** `tooltip` had three states — `rich`, `minimal`,
> `off` — and density has three levels that must also carry row 2 and signals, so one
> state had to go. **`minimal` (overflow fields only, no backend fetch) is the one
> dropped**, as the least-used middle. If the user wants it back it becomes a fourth
> density level or a separate `hoverCard` setting; say so and it is cheap.

## B61 — a hidden thing costs nothing

Hiding is not cosmetic. A disabled element skips its work, not just its pixels. This
matters because windowing was removed to protect B44, leaving performance at ~170
threads an explicitly unmeasured bet — so these toggles are the lever that exists
instead.

- **B61.1** (auto) `showPrChip: false` **never calls
  `experimental_useSidebarThreadPullRequest`**. Use the two-component pattern
  `ThreadRow` already uses for its `environment === null` gate; a hook cannot be called
  conditionally. This removes the last per-row host hook from the list.
- **B61.2** (auto) `density: "compact"` mounts **no** `IntersectionObserver` and issues
  **no** `rowSignals` request.
- **B61.3** (auto) Assert both as call-count tests, not as absence-of-DOM tests: render
  a list with the setting off and assert zero matching entries in
  `inspection.rpcCalls` / the PR hook's call sites.

## B62 — the viewport does not override the user

- **B62.1** (auto) The density setting applies at **every** viewport, phone included.
  The user explicitly wants repo and branch on the phone; a phone that silently
  disobeys a stated setting is worse than a dense phone.
- **B62.2** (auto) `isCompactViewport` still governs only what is already specced as
  viewport-dependent: **B32** (no dossier on compact viewports) and **B55** (the title
  truncates rather than wrapping). Those are correctness rules, not preferences.
- **B62.3** There is deliberately **no per-device setting**. bb offers no per-device
  settings API, and a second storage tier would double the surface and the test matrix
  for a problem B62.2 already solves.

## Decisions recorded, not re-litigated

- **`showRelativeTime` exists over my objection.** I argued time is the organising
  premise of a date-grouped sidebar and hiding it undermines the plugin's reason to
  exist. The user chose to include it. With time hidden, B51.5's "time is the only
  fixed-width slot" no longer has an anchor, so the trailing cluster becomes fully
  intrinsic; B57.4's uniform-gap rule already covers the spacing.
- **`secondRow` and `tooltip` are dropped without migration.** Their stored values
  orphan harmlessly because `parseSettings` ignores unknown keys. One README line, no
  migration code.
- **The host renders the settings form** from the descriptors. No `settingsSection`
  slot: seven plain controls do not justify a hand-built UI.
