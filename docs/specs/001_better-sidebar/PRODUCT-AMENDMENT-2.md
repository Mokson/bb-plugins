# PRODUCT amendment 2 — child threads chip in the thread header

Requested by the user: *"add the child threads widgets in the main header like t3
sidebar plugin has."* Reference:
`.bb-refs/bb-plugin-t3sidebar/src/SubagentsChip.tsx`.

This is a **second slot registration**, not a sidebar change. It uses
`app.slots.experimental_threadHeaderAction`, the frontend sibling of the backend
`bb.ui.registerThreadAction`. Invariants continue from B58.

## Why it earns its place here

t3 *needs* this chip: its list is flat, so it hides child threads and the header is
the only home they have. **Our list nests children under their parents already**, so
the chip is not rescuing hidden data. It earns its place for a different reason, and
the design should follow that reason rather than copying t3's:

- the header is reachable when the sidebar is **collapsed**, or on a phone where the
  sidebar is an off-screen drawer;
- when you are reading a thread, its children are the thing you most want to jump
  between, and the sidebar makes you find the parent first;
- a child that **needs you** is worth surfacing on the parent you are looking at.

## B58 — the chip

- **B58.1** (auto) Registered as `experimental_threadHeaderAction` with id `children`,
  title `Child threads`.
- **B58.2** (auto) **Renders nothing at all when the thread has no children.** Most
  threads have none; an empty chip is chrome tax on every header.
- **B58.3** (auto) Collapsed, the chip shows a cluster of up to **three** provider
  glyphs for its children, overlapped, plus an overflow marker when there are more,
  and a label reading `N children` — or **`Needs you`** when any child has
  `hasPendingInteraction`.
- **B58.4** (auto) On `isCompactViewport` the label is dropped and the chip collapses
  to the glyph cluster alone. The header is a short row and the phone is a real
  target.
- **B58.5** (auto) The chip fits bb's header chrome: **28px tall inside a 48px row**,
  and it is a `shrink-0` inline control. Anything taller than 28px is a portalled
  popover, never an inline panel.
- **B58.6** (auto) Open, it lists every child: the child's **provider glyph**, its
  title resolved the same way row 1 resolves one, its origin (`fork` or `thread`), and
  its **status glyph**. Clicking a child opens it and closes the popover.
- **B58.7** (auto) It reuses this plugin's own `ProviderGlyph`, `StatusGlyph` and
  `Glyph` — **not** a second visual vocabulary. A user who learned the five states in
  the sidebar must not have to learn different marks in the header.
- **B58.8** (auto) The popover is **portalled and portal-scoped** through the same
  `usePortalScopeProps()` every other overlay in this plugin uses (§9). t3 hand-rolls
  an absolutely-positioned div plus a `fixed inset-0` click-away; we already have the
  portal seam and the host's outside-click behaviour to contend with, so we use it.
- **B58.9** (auto) A split layout renders **one header per pane**, so this component
  mounts once per visible thread. Open state lives in the component, **never** in a
  module-level singleton — otherwise opening the chip in one pane opens it in every
  pane. Assert this with two mounted instances.
- **B58.10** (auto) A throw in this component must not take out the thread header. The
  host contains it to the one action, but the component still degrades to rendering
  nothing rather than throwing on unexpected data.

## Vocabulary, deliberately

bb's **in-turn subagents** are activity counters on the parent thread
(`activity.backgroundAgents`), not threads. This chip lists **child threads** — forks,
side chats, and plugin-spawned threads. The two sets overlap and are not the same, so
the label says *children*, never *subagents*.

## Not in scope, offered separately

t3 also registers a **parent chip** (`ParentChip`, 48 lines) that navigates from a
child up to its parent. It is the natural complement to this one and cheap to add, but
the user asked for the child-threads widget specifically, so it is **not** built here.
Say the word and it is a small follow-up.

---

# Amendment 2a — the chip's child rows carry real information

**Supersedes B58.6's origin line.** That line rendered `originKind ?? "thread"`, and
almost every child is a plain thread, so it said "thread" over and over. The user asked
for information worth the row: **model, effort, duration**.

## B70 — what a child row shows

```
[provider glyph] title
                 <model> · <effort> · <duration>        [status glyph]
```

- **B70.1** (auto) **Duration is elapsed since creation** — `now - createdAt` while the
  thread is running, `updatedAt - createdAt` once it is not. It answers *how long did
  this take*, which is the question when scanning seats you dispatched. It deliberately
  is **not** time-since-last-activity: row 1 in the sidebar already carries that, and
  repeating it here would spend the row on a signal the user has.
- **B70.2** (auto) Model is the resolved model id, shortened for a narrow row the way
  the dossier already shortens it. Effort is `reasoningLevel`.
- **B70.3** (auto) The origin (`fork`) is kept **only when it is not the default** — a
  fork is worth naming, a plain thread is not. `"thread"` never renders.
- **B70.4** (auto) Any of the three missing renders **nothing in its place**, and the
  separators collapse with it. A thread that never resolved execution options has no
  model and no effort (the same `null` B29 handles), and it must not show empty
  separators or placeholder dashes.

## B71 — one batched call, only while open

- **B71.1** (auto) A new **batched** RPC — `threadExecutions(ids)` — returns
  `{model, reasoningLevel} | null` per id, from
  `bb.sdk.threads.defaultExecutionOptions`. **One request per popover open**, whatever
  the child count; this run's own parent has seventeen children, so per-child calls
  were rejected.
- **B71.2** (auto) **Nothing runs while the chip is closed**, which is nearly always.
  The chip renders collapsed with no RPC at all — the glyph cluster and count come from
  `experimental_useSidebarThreads()`, which costs nothing extra.
- **B71.3** (auto) This is the chip's **first** RPC, so it gains the states it has never
  had: **loading** (rows render with title and glyphs, the metadata line absent — never
  a spinner that shifts the layout) and **error** (rows still render; the metadata line
  is simply absent). A failed lookup must never blank the child list — the titles and
  the navigation are the point, the metadata is enrichment.
- **B71.4** (auto) Results are cached and reused across opens with the same TTL
  discipline as the dossier, so re-opening a chip inside the window issues no second
  request.
- **B71.5** (auto) Assert B71.1 and B71.2 as **call-count** tests: closed chip → zero
  `rpcCalls`; one open with seventeen children → exactly one; a second open inside the
  TTL → still one.

## B72 — it obeys the settings

- **B72.1** (auto) `density: "compact"` guarantees **no backend RPC of any kind**
  (B60.1). The chip honours that: at `compact` it renders child rows with title,
  provider and status, and makes **no** `threadExecutions` call.
- **B72.2** (auto) `showHeaderChip: false` (B59) removes the chip entirely, and with it
  this RPC.
