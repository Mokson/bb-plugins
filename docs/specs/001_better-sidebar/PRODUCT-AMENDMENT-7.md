# PRODUCT amendment 7 — a display-options menu holds grouping and project scope

Requested by the user: put the project filter into a menu beside the group-by
options. **Supersedes B64.1's full-width `Select`.**

## The fact that shapes it

The group-by options the user was looking at are **bb's own**. The host bundle
carries a "Display options" menu with a `Sort by` radio group
(`app/dist/assets/index-CUMoMqjq.js`), and the SDK publishes **no slot into it** —
the app slots are `experimental_threadList`, `experimental_threadHeaderAction`,
`experimental_sidebarAccessory` and the panel/footer registrations. So this is not
moving the filter into an existing menu; it is building our own inside the list we
own.

## B76 — the menu and its trigger

- **B76.1** (auto) `ProjectFilter`'s full-width `Select` is **replaced**. The slim
  row it lived in keeps its place at the top of the plugin's scroll area and holds a
  **right-aligned icon button** that opens one dropdown menu.
- **B76.2** (auto) When a project scope is active the same row shows it on the left
  as a **chip with a clear control**. An active filter is never invisible: the row
  that hides the control must still say the list is not showing everything.
- **B76.3** (auto) With no scope active the row is the button alone, so the resting
  state costs ~24px rather than the `Select`'s ~32px.
- **B76.4** (auto) Present at **every viewport** (B64.5 unchanged). A phone has no
  right-click, so a visible trigger is the only reachable one; the menu is not
  bound to a context-menu gesture.
- **B76.5** (auto) The menu is **portalled and portal-scoped** through
  `usePortalScopeProps()`, the seam every overlay in this plugin uses (B58.8).
- **B76.6** (auto) Two submenus only: **Group by** and **Filter**. The other six
  settings stay in bb's settings form — they are set once, not changed while reading
  the list, and duplicating them would put the same value in two places.

## B77 — Group by lives in the menu

`groupBy` keeps its five values (B65): `date`, `project`, `host`, `status`, `none`.

- **B77.1** (auto) The submenu is a **radio group**: exactly one value is checked,
  and choosing one re-groups the list immediately.
- **B77.2** (auto) **The menu writes to `localStorage`**, through the existing
  `src/lib/local-store.ts` seam `useCollapse` already uses.

  This is forced, not preferred. `PluginSettingsHandle` exposes `get()` and
  `onChange()` and no setter, and the app's `PluginSettingsState` is
  `{values, isLoading}` — a plugin cannot write its own settings from the app.
  The remaining route is an RPC to our own server, and that would break **B60.1**,
  which promises `density: "compact"` performs no backend call of any kind. A
  `localStorage` write costs no request.
- **B77.3** (auto) **Precedence: the stored value wins when present, otherwise the
  `groupBy` setting.** The setting stays in bb's form and becomes the *default* — the
  value a device uses until its user picks one. Both must be exercised in tests.
- **B77.4** (auto) A stored value outside the five falls back to the setting, the
  same tolerance `parseSettings` already applies (B59.2). A user editing
  localStorage by hand must not blank the sidebar.
- **B77.5** (auto) The choice is **per device**, because localStorage is. Changing
  it on the phone does not change it on the desktop. This is stated, not hidden.

## B78 — Filter by project lives in the menu

- **B78.1** (auto) The submenu lists **All projects** then each project by name,
  as B64.1 specified, now as menu items rather than a `Select`.
- **B78.2** (auto) **Session state only** — B64.2 is unchanged and load-bearing. The
  scope lives in component state, never in settings, never in `localStorage`, never
  on the backend. A forgotten filter must not outlive the tab, and it must **not**
  follow `groupBy` into the store just because they now share a menu.
- **B78.3** (auto) B64.3 (composes with search), B64.4 (an empty scope renders the
  no-matches state naming the project) and B64.6 (scope does not change band
  precedence) are unchanged.
- **B78.4** (auto) The checked item reflects the active scope, so the menu answers
  "what am I looking at" without closing it.

## What this does not change

- B68.5: reconciliation still runs over the **unfiltered** thread set. Scope is
  presentation, and clearing it must not reshuffle the list.
- B60.1: `compact` still performs no backend RPC. This amendment adds none.
