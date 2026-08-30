# PRODUCT amendment 4 — project filter and two more grouping modes

Settled with the user. Invariants continue from B64. **Extends B8 and B48**; nothing
here supersedes an existing invariant.

## B64 — a project scope filter

t3 ships exactly one filter control and so do we. The user explicitly rejected a
"needs you only" filter on the grounds that **attention is a group, not a filter** —
which B1's NEEDS YOU band already provides. That is the right instinct: a filter hides
things, and the one thing you must never hide is the thread waiting on you.

- **B64.1** (auto) One `Select` at the top of the plugin's own scroll area — the host
  owns the New-thread and search row above it, so this is the only place a plugin
  control can live. Options: **All projects**, then every project by name.
- **B64.2** (auto) **The filter is session state, never persisted.** It lives in
  component state and resets on reload, exactly as t3's does. This is a safety
  property, not an oversight: a filter you forgot you set makes threads silently
  disappear, and a sidebar that hides your work is worse than one that shows too much.
  It must not go in settings, `localStorage`, or the backend.
- **B64.3** (auto) The filter **composes with search**. With a non-empty `searchQuery`
  the list still flattens per B43, and the project scope still applies to the results.
- **B64.4** (auto) Filtering to a project with no matching threads renders the
  **no-matches** list state (ruling 11), with copy naming the project — never a blank
  list, and never the generic "no threads yet" state, which would be a lie.
- **B64.5** (auto) The control is present at every viewport, including compact. It is
  one row of chrome and it is how a phone user reaches a single project in a
  113-thread list.
- **B64.6** (auto) Scoping to one project does not change the NEEDS YOU or PINNED
  bands' precedence (B1); it only removes threads outside the scope from every section.

## B65 — two more grouping modes

`groupBy` extends from `date | project | none` to **`date | project | host | status |
none`**. The user chose host and status; **provider grouping was offered and declined**
and is deliberately not built.

### `host`

- **B65.1** (auto) Groups by `host.name`, the machine the work runs on.
- **B65.2** (auto) `host` is nullable. Threads with no host group under a final
  **No machine** section, never dropped and never crashed on.
- **B65.3** Honest note: this mode is near-inert while everything runs on one machine.
  It earns its place when remote execution machines exist, and costs one rendering path
  until then.

### `status`

- **B65.4** (auto) Groups by the **five-state vocabulary already on the row** (B20-B22):
  Needs you · Working · Planning · Draft · Idle. It does **not** invent a second status
  language — a user who learned the glyphs must read the same words here.
- **B65.5** (auto) **The NEEDS YOU band merges with the first group in this mode.**
  Grouping by status while also floating a needs-you band above would render the same
  threads twice under two headings for the same concept. In `status` mode the band is
  simply the first group; B1's precedence is satisfied by ordering, not duplication.
- **B65.6** (auto) The **PINNED band still floats above** all status groups, as in
  every other mode. Pinning is a user act, not a thread state, so it does not collide.
- **B65.7** (auto) Empty status groups render nothing (B4). Most lists will show two or
  three of the five.

### Both

- **B65.8** (auto) These modes **replace** the date buckets exactly as `project` does
  today; they do not nest inside them. There is no two-level grouping.
- **B65.9** (auto) Child nesting (B9), the freeze (B6), search flattening (B43) and the
  root-only section counts (B53.4) all behave identically in the new modes. They are
  new section *keys*, not a new sectioning mechanism — if implementing them needs
  changes to `applyFreeze` or the count logic, that is a signal the abstraction is
  wrong, not that those rules need special cases.
- **B65.10** (auto) `secondRow`'s mode-awareness (now `density`, B60) treats `host` and
  `status` like `date` and `none` — row 2 shows on roots, because neither mode conveys
  the project, which is the thing flattening destroys.
