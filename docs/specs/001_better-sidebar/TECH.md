# TECH — Better Sidebar

How to build the behavior contract in [PRODUCT.md](PRODUCT.md). This file decides
structure, seams, and decomposition. It never decides behavior: where an invariant
and the SDK disagree, §7 records the ruling and PRODUCT.md is left untouched.

Repo: `Mokson/bb-plugins` @ `a663c54`, plugin package `plugins/better-sidebar/`.
Every path below is relative to that package.

---

## 1. Context

The package is a proven-working scaffold: `app.tsx` registers an
`experimental_threadList` slot with a placeholder, `src/server.ts` logs and returns,
`src/scaffold.test.ts` asserts the backend factory loads. No feature code.

Pinned SDK is `@get-bb/plugin-sdk` **0.4.21** (bb 0.40.0's embedded version). Types
read from `node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk-app.d.ts`
(frontend) and `bb-plugin-sdk.d.ts` (backend). Facts this spec is built on:

| Fact | Evidence |
| --- | --- |
| Slot props: `activeThreadId`, `activeProjectId`, `isCompactViewport`, `onNavigate`, `searchQuery`, `Original` | `bb-plugin-sdk-app.d.ts:405-433` |
| `PluginSidebarThread` has no model, token, cost or context field; `environment` and `host` are **nullable** | `:907-956` |
| `PluginSidebarThreadIndicator` is a 12-member union; no rate-limit member | `:886` |
| `experimental_useSidebarThreadPullRequest(threadId)` — one hook call per row | `:2172` |
| `experimental_useSidebarThreadSplit(threadId)` — one hook call per row | `:2178` |
| The SDK advises "Window your rows … a list that mounts one row per thread is slow" — **deliberately not followed**, see §6 | `:2151-2158` |
| `experimental_useSidebarThreadActions` covers open/openNewThread/setPinned/setRead/rename/archive/requestDelete | `:1008-1036` |
| `useSettings(): {values: Record<string, string \| boolean> \| undefined, isLoading}` — settings are readable frontend-side, no RPC needed | `:1551-1558` |
| `ProviderInfo.logoUrl` is `string \| null`; `strings` optional; `strings.iconTint` optional inside it | `:236, :254-258` |
| `bb.sdk.threads.defaultExecutionOptions({threadId})` → `ResolvedThreadExecutionOptions \| null` with `model` and `reasoningLevel` | `bb-plugin-sdk.d.ts:15436, :15240, :3098-3124` |
| `bb.sdk.threads.events.list({threadId, types, order, limit, afterSeq})` — `limit` is a **string** | `bb-plugin-sdk.d.ts:15329-15341` |
| `thread/tokenUsage/updated` carries `tokenUsage.total.{totalTokens,inputTokens,cachedInputTokens,outputTokens,reasoningOutputTokens}` and `modelContextWindow` | `:2148-2166` |
| `thread/contextWindowUsage/updated` carries `{usedTokens, modelContextWindow, estimated}`, `usedTokens` nullable | `:2168-2176` |
| `provider/modelFallback` carries `{originalModel, fallbackModel, reason, message}` | `:2284-2294` |
| `thread/goal/updated` carries `{objective, status, tokensUsed, tokenBudget, timeUsedSeconds}` | `:702-715` |
| **`bb.events.on` exposes only** `thread.created`, `thread.active`, `thread.idle`, `thread.failed`, `thread.archived`, `thread.deleted` — **no token-usage event** | `:15716-15745` |
| `bb.settings.define` select form is `{type:"select", label, description?, options: string[], default?}` | `:15657-15663` |
| The host's nine thread shortcuts are `thread.jump.1`…`thread.jump.9` plus `thread.next` / `thread.previous` | `:105-116` |
| Test harness: `loadPluginApp`, `renderSlot(registration, props, {rpc, settings, sidebarThreads, providers, sidebarPullRequests, …})`, plus `emitRealtime` | `bb-plugin-sdk-testing-app.d.ts:140, :273, :176-232, :236-240` |

Two constraints that shape the file layout:

- **No icon library.** `package.json` has no `@hugeicons/*` or `lucide-react`, and
  installing one is out of scope for this spec's slices. Every glyph is hand-authored
  inline SVG, the way `.bb-refs/bb-plugin-t3sidebar/src/ProviderGlyph.tsx` does it.
  Radix (`react-hover-card`, `react-context-menu`, `react-tooltip`, `react-popover`),
  `clsx`, `tailwind-merge` and `zod` are already present and are used.
- **No Tailwind config of our own.** Only classes the host's stylesheet already ships
  are available. `animate-pulse` and `animate-spin` exist; `animate-shine-icon`
  (used by `.bb-refs/bb-sidebar`) does not — it is that plugin's own keyframe.
  B22's "slow pulse" is `animate-pulse motion-reduce:animate-none`.

`vitest.config.ts` needs **no** change: DOM tests opt in per file with
`// @vitest-environment jsdom`, which is the documented pattern
(`bb-plugin-sdk-testing-app.d.ts:34`) and what
`.bb-refs/bb-plugin-t3sidebar/src/ThreadInbox.test.tsx:1` does. This is deliberate —
it keeps `vitest.config.ts`, `tsconfig.json` and `package.json` outside every slice's
ownership set, which is what makes §8 safe to run in parallel.

---

## 2. Module layout

```
app.tsx                          slot registration; the only file bb loads for the frontend
src/
  ThreadList.tsx                 the slot component: wires hooks → model → rows, and the
                                 loading / error / empty / no-match branches
  ListStates.tsx                 skeleton, error, empty and no-match renderings
  useFreeze.ts                   B6 pointer-freeze state machine; returns FrozenOrder | null
  useNow.ts                      quantized clock + midnight re-partition tick (B3)
  useCollapse.ts                 collapse state for buckets and subtrees, localStorage-backed
  settings.ts                    setting keys, defaults, and the parse of useSettings().values
  server.ts                      backend factory: settings.define, rpc.register, event hooks
  server-contract.ts             defineRpcContract + zod schemas, imported by both sides
  lib/
    utils.ts                     cn()
    portal-scope.ts              usePortalScopeProps() for every Radix portal
    local-store.ts               namespaced, schema-validated localStorage read/write
  ui/
    HoverPopover.tsx             Radix HoverCard wrapper with portal scope + hover-intent
    Glyph.tsx                    inline-SVG glyph primitives (no icon dependency)
  model/
    types.ts                     ListModelInput, ListModel, RenderSection, RenderRow, FrozenOrder
    buckets.ts                   B2 local-calendar bucketing + B41 dim levels
    list-model.ts                buildListModel(): the single pure list seam
    search.ts                    B43 match ranking
  row/
    ThreadRow.tsx                row 1 + row 2 composition, host contract attributes;
                                 owns the single per-row PR hook call
    SecondRow.tsx                B15-B19 metadata line
    StatusGlyph.tsx              B20-B22 five-state glyph
    ProviderGlyph.tsx            B23-B25 masked provider logo
    PrChip.tsx                   B33-B36 pull-request chip; purely presentational
    relative-time.ts             coarse age label
  dossier/
    RowHover.tsx                 B26-B32 hover trigger wrapper a row wraps its content in
    useDossier.ts                B26-B28 hover-intent + frontend TTL cache + RPC + status
    Dossier.tsx                  B29-B32 popover contents
    RowSignals.tsx               B37-B40 extra row glyphs, fed by the batched signals RPC
    useRowSignals.ts             viewport-visible batch fetch + realtime invalidation
  menu/
    RowContextMenu.tsx           B46 right-click menu
    useRenameEditor.ts           B46 inline rename state; the row renders the input
  keyboard/
    bucketJump.ts                B42 shortcut table and handler (pure where it can be)
```

The split is not cosmetic. Everything under `src/model/` is a pure function of plain
data — no React, no DOM, no SDK hooks — so B1, B2, B5, B9, B41 and B43 are provable
in a `.test.ts` that runs in the default node environment in under a second. That is
the property §8's slice 1 is built around: the hardest logic in the plugin ships with
the cheapest possible feedback loop.

---

## 3. The list-model seam

**One** exported function. Everything about which thread appears where lives behind it.

```ts
// src/model/types.ts
export type GroupBy = "date" | "project" | "none";
export type SecondRowMode = "auto" | "always" | "never";
export type TooltipMode = "rich" | "minimal" | "off";

export interface BetterSidebarSettings {
  groupBy: GroupBy;
  secondRow: SecondRowMode;
  tooltip: TooltipMode;
}

export type SectionKey =
  | "needs-you"
  | "pinned"
  | "today" | "yesterday" | "last-7" | "last-30" | "older"
  | `project:${string}`
  | "all"
  | "search";

/** The snapshot B6 pins the rendered order to. Plain data, so the model stays pure. */
export interface FrozenOrder {
  /**
   * The WHOLE rendered sequence at the instant of the freeze, in visual order —
   * every row of every section, flattened. Freezing per section would let a
   * growing top section shift every row below it; freezing the sequence cannot.
   */
  readonly ids: readonly string[];
  /** The section each frozen id was in; a frozen row never changes section. */
  readonly sectionOf: Readonly<Record<string, SectionKey>>;
  /** Section order at the instant of the freeze; sections do not reorder either. */
  readonly sectionOrder: readonly SectionKey[];
}

export interface ListModelInput {
  readonly threads: readonly PluginSidebarThread[];
  readonly projects: readonly PluginSidebarProject[];
  readonly settings: BetterSidebarSettings;
  readonly searchQuery: string;
  /** Epoch ms, quantized by the caller so the model is stable across renders. */
  readonly now: number;
  readonly frozen: FrozenOrder | null;
  readonly collapsedSections: ReadonlySet<SectionKey>;
  readonly collapsedThreadIds: ReadonlySet<string>;
}

export interface RenderRow {
  readonly thread: PluginSidebarThread;
  /** B13, resolved here: `title ?? titleFallback ?? "Untitled"`, already trimmed. */
  readonly title: string;
  /** B16, resolved here per the §7 ruling; null when nothing in the chain applies. */
  readonly workspaceLabel: string | null;
  /** 0 for a root row; +1 per parent hop. Drives the B9 indent. */
  readonly depth: number;
  /** Direct children of this row that exist in `threads`; drives the B10 chevron. */
  readonly childCount: number;
  /** Project name for the B43 flat list and the B15 metadata line; null when unknown. */
  readonly projectName: string | null;
  /** B41. 0 = full opacity, rising with bucket age, capped at DIM_FLOOR. */
  readonly dimLevel: 0 | 1 | 2 | 3;
  readonly sectionKey: SectionKey;
}

export interface RenderSection {
  readonly key: SectionKey;
  readonly label: string;
  /** B7: threads contained, counting nested children. */
  readonly count: number;
  readonly isCollapsible: boolean;
  readonly isCollapsed: boolean;
  /** Pre-order flat: parent immediately followed by its visible subtree. */
  readonly rows: readonly RenderRow[];
}

export interface ListModel {
  readonly sections: readonly RenderSection[];
  /** Sum of `rows.length` over expanded sections. Every one of them is mounted. */
  readonly rowCount: number;
}

// src/model/list-model.ts
export function buildListModel(input: ListModelInput): ListModel;
```

Order of operations inside `buildListModel`, which is where B1's "exactly once" is
enforced structurally rather than by discipline:

1. **Visibility.** Drop `isArchived` threads unless the thread's parent chain is
   entirely present and expanded (B11).
2. **Search short-circuit.** Non-empty `searchQuery` → `rankSearch()` from
   `search.ts` returns one `RenderSection` with `key: "search"`, every row at
   `depth: 0`, `dimLevel: 0`, `projectName` always populated, sorted by match score
   then `latestAttentionAt` descending (B43). Steps 3-5 are skipped; steps 6 and 7
   still run, so search rows carry a resolved `title` and `workspaceLabel` like any
   other row and a freeze in progress still pins the result.
3. **Root resolution.** Each thread walks `parentThreadId` to its topmost ancestor
   present in the visible set. That ancestor's assignment decides the whole subtree
   (B9). A thread whose parent is absent is its own root — an orphan stays reachable.
4. **Section assignment**, on roots only, in strict order: `hasPendingInteraction` →
   `needs-you`; else `isPinned` → `pinned`; else per `settings.groupBy` (B8) — `date`
   uses `bucketOf(latestAttentionAt, now)` from `buckets.ts`, `project` uses
   `project:${projectId}`, `none` uses `all`. A single-assignment `Map<id, SectionKey>`
   is the mechanism: one write per root, so B1 cannot be violated by adding a section.
5. **Sort.** Within each section, roots by `latestAttentionAt` descending, ties broken
   on `id` so the order is total and stable (B5). Children sort the same way beneath
   their parent, so B12's recent-child-under-old-parent case reads correctly.
6. **Flatten and prune.** Pre-order walk emitting `RenderRow`s, stopping at collapsed
   parents; `dimLevel` from `buckets.ts` (0 for `needs-you`/`pinned`/`today`); sections
   with zero rows are dropped entirely (B4). Each row resolves its own `title`
   (B13: `title ?? titleFallback ?? "Untitled"`, trimmed) and `workspaceLabel`
   (B16, per the §7 ruling: `environment.branchName` → `environment.name` when
   `workspaceDisplayKind` is a worktree kind → `host.name` → null, and null outright
   when `environment` is null). Both are strings on `RenderRow`, so slice 3 renders
   them without re-deriving anything.
7. **Freeze overlay.** See §4. Applied to the flattened sequence, so it must run
   last. Skipped when `input.frozen` is null.

The interface is small (one function, two named types) and the implementation carries
five invariants that would otherwise be spread across the component tree. Deleting it
would reproduce bucketing, precedence, nesting and search in `ThreadList.tsx` — it
passes the deletion test.

---

## 4. The freeze mechanism (B6)

The snapshot is plain data (`FrozenOrder`) held in a `useRef` inside `useFreeze.ts`
and passed into `buildListModel` as an input. It is never React state that re-renders
on its own, and the model never reads the DOM. That is what makes the subtlest
requirement in the spec unit-testable.

### State machine

```
                 pointerenter(list)
      ┌──────────────────────────────────► FROZEN
      │                                    │   ▲
      │                                    │   │ pointerenter(list)
      │                                    │   │ (keeps the SAME snapshot)
      │                     pointerleave   │   │
      │                                    ▼   │
    LIVE ◄──── 2000ms timer elapsed ──── COOLDOWN
      ▲
      └── any invalidator, from FROZEN or COOLDOWN
```

| State | `frozen` passed to the model | Timer |
| --- | --- | --- |
| `LIVE` | `null` | none |
| `FROZEN` | the snapshot | none |
| `COOLDOWN` | the same snapshot | 2000ms, one-shot |

**Entering FROZEN** captures `{ids, sectionOf, sectionOrder}` from the *live* model
computed on that render — the entire rendered sequence the user is currently looking
at, flattened across every section, not one snapshot per section.

**COOLDOWN → FROZEN keeps the old snapshot.** Re-freezing on re-entry would let a
reorder that happened during the 2s gap land the instant the pointer comes back, which
is exactly the jump B6 exists to prevent.

**Invalidators — any of these drops the snapshot and returns to LIVE immediately:**

- `searchQuery` changes (searching is an explicit act; stale order would be a bug)
- `settings.groupBy` or `settings.secondRow` changes
- the window blurs, or `document.visibilityState` becomes `hidden`
- a thread is opened through `actions.open` (the list is about to be navigated away
  from; the pointer's context is gone)

Collapsing or expanding a section or subtree does **not** invalidate: that is a layout
change the user made deliberately, and re-sorting under their cursor as a side effect
of it is the same defect.

### How the overlay is applied (step 7 of §3)

The unit the overlay operates on is **the whole flattened sequence**, not one section
at a time. Per-section appending was the earlier design and it was wrong: a newcomer
that creates or extends the top section pushes every row in every section below it
down, which is precisely the movement B6 forbids. Freezing the sequence makes that
impossible by construction.

Given `frozen` and the freshly built sections:

1. Sections render in `frozen.sectionOrder`. A section that had rows at freeze time
   keeps its position even if it is now empty of frozen rows; a section that did not
   exist at freeze time is appended after the last frozen section.
2. Every id in `frozen.ids` that still exists is forced into
   `frozen.sectionOf[id]` at index `frozen.ids.indexOf(id)`. Its live section and live
   sort position are ignored.
3. An id in `frozen.ids` that no longer exists (deleted, archived, filtered out) is
   simply omitted. Surviving rows close the gap; they do not re-sort.
4. **A thread not in the snapshot renders immediately, appended to the end of the
   ENTIRE list** — after the last row of the last frozen section, in arrival order,
   visually unseparated from the section above it. It gets no section header of its
   own while frozen. Nothing above it can move, because nothing above it is
   recomputed.
5. On release, the snapshot is dropped, steps 1-6 of §3 run unmodified, and the
   newcomers animate into their sorted positions.

Point 4 is a deliberate reading of B6's "New threads that arrive while frozen append
at their sorted position on release" — see the §7 ruling. Holding a new `NEEDS YOU`
thread invisible for up to 2s after the pointer leaves would be a worse failure than
the reorder B6 forbids; appending at the very end is the only insertion position that
provably moves no existing row.

### Verification

`buildListModel` takes `frozen` as an argument, so points 1-5 are pure-function tests
in `src/model/list-model.test.ts` with no DOM at all. **The load-bearing test:** given
a frozen snapshot, a newly arriving `hasPendingInteraction` thread changes no existing
row's index — assert the full rendered id sequence's first N entries are byte-identical
before and after, with the newcomer at index N. The *machine* — which state we are in
and when — is tested in `src/ThreadList.test.tsx` through `renderSlot` with
`fireEvent.pointerEnter` / `pointerLeave` and `vi.useFakeTimers()`, asserting the
rendered `data-sidebar-thread-id` sequence before and after `vi.advanceTimersByTime(2000)`.

---

## 5. The backend contract

`src/server-contract.ts` is imported by both sides and holds nothing but zod and
`defineRpcContract`, so the frontend never pulls the backend's node imports.

```ts
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const threadIdSchema = z.string().trim().min(1);

const tokenTotalsSchema = z.object({
  totalTokens: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  reasoningOutputTokens: z.number(),
});

export const dossierSchema = z.object({
  threadId: z.string(),
  /** null when the thread never resolved execution options (never ran). */
  execution: z
    .object({ model: z.string(), reasoningLevel: z.string() })
    .nullable(),
  /** null when the provider reports no token usage. B31's no-data case. */
  economics: z
    .object({
      total: tokenTotalsSchema,
      modelContextWindow: z.number().nullable(),
    })
    .nullable(),
  contextWindow: z
    .object({
      usedTokens: z.number().nullable(),
      modelContextWindow: z.number().nullable(),
      estimated: z.boolean(),
    })
    .nullable(),
  /** Epoch ms the backend produced this payload; drives the frontend TTL. */
  fetchedAt: z.number(),
});

export const rowSignalSchema = z.object({
  threadId: z.string(),
  /** B37: usedTokens / modelContextWindow, or null when either is missing. */
  contextPressure: z.number().nullable(),
  /** B38 */
  modelFallback: z
    .object({
      originalModel: z.string(),
      fallbackModel: z.string(),
      reason: z.string(),
      message: z.string(),
    })
    .nullable(),
  /** B39: true when the newest provider/rateLimits/updated event parks the thread. */
  isRateLimitPaused: z.boolean(),
  /** B40 */
  goal: z
    .object({
      status: z.string(),
      tokensUsed: z.number(),
      tokenBudget: z.number().nullable(),
    })
    .nullable(),
});

export const betterSidebarRpcContract = defineRpcContract({
  /** One hovered thread's dossier. B31 returns nulls, never throws. */
  threadDossier: {
    input: z.object({ threadId: threadIdSchema }),
    output: dossierSchema,
  },
  /** Row glyph signals for the ids currently VISIBLE IN THE VIEWPORT only. */
  rowSignals: {
    input: z.object({ threadIds: z.array(threadIdSchema).max(60) }),
    output: z.object({ signals: z.array(rowSignalSchema) }),
  },
});

export const DOSSIER_CHANNEL = "thread-dossier";
```

There is **no collapse RPC**. B7 and B10 collapse state is a client-local preference,
so it lives in `localStorage` behind `src/lib/local-store.ts` (slice 2), the pattern
`.bb-refs/bb-sidebar/src/ThreadInbox.tsx:90-104` already uses. That deletes an RPC
pair, a kv table, a realtime channel and their tests, and it removes slice 2's
dependency on slice 5 entirely. The helper namespaces its key
(`better-sidebar:collapse:v1`), validates the parsed shape against a zod schema, and
returns the default on any parse failure or when storage is disabled — a hardened
browser must degrade to "nothing collapsed", never throw.

### Handlers

| Method | SDK calls |
| --- | --- |
| `threadDossier` | `bb.sdk.threads.defaultExecutionOptions({threadId})` → `execution` (`null` result → `execution: null`). `bb.sdk.threads.events.list({threadId, types:["thread/tokenUsage/updated"], order:"desc", limit:"1"})` → `economics` from `rows[0].data.tokenUsage.total` and `.modelContextWindow`; empty array → `economics: null`. Same call with `types:["thread/contextWindowUsage/updated"]` → `contextWindow`; empty → `null`. |
| `rowSignals` | Per id, **one call per event type**, each `order:"desc"` with its own limit: `["thread/contextWindowUsage/updated"] limit:"1"`, `["provider/modelFallback"] limit:"1"`, `["provider/rateLimits/updated"] limit:"1"`, `["thread/goal/updated","thread/goal/cleared"] limit:"1"`. That is **4 `events.list` calls per thread**. `thread/goal/cleared` newest → `goal: null`. |

**One call per type, not one call for all five.** `ThreadEventsListArgs.limit` applies
one overall cap to the *filtered* list (`bb-plugin-sdk.d.ts:15329-15340`), so a single
combined request with `limit:"25"` lets 25 recent goal or rate-limit rows push an older
but still-current `provider/modelFallback` row out of the result and silently erase its
required glyph. Each signal only ever needs the newest row of its own type, so a
`limit:"1"` call per type is both correct and smaller than the combined read. Goal
update and goal cleared share one call because they are one signal and the newer of the
two wins.

**Call-count budget.** 4 calls per thread × the ≤60 visible ids the contract accepts =
**≤240 `events.list` calls per cold batch**, against a local server, once per 30s TTL
window and only for rows actually on screen. The `.max(60)` on the input is what bounds
it; the frontend must chunk a larger visible set rather than raising the cap.

**B31 is a return value, not an error.** Every "no data" path resolves with a null
field. A handler throws only on a genuine SDK failure, and the frontend distinguishes
the two — see the `status` machine in §5's frontend cache paragraph and the `error`
branch tests in slice 4. `limit` is a **string** in `ThreadEventsListArgs`
(`bb-plugin-sdk.d.ts:15334`) — passing a number is a type error.

### Cache and invalidation (B28)

**Backend, `src/server.ts`.** A `Map<string, {value, expiresAt}>` per method:
`threadDossier` TTL **10s**, `rowSignals` TTL **30s**. Cheap, bounded (entries are
evicted on read when expired and on `thread.deleted`), and it absorbs the re-hover
burst that a user aiming at a popover produces.

Invalidation is **event-driven, not channel-driven**, because the channel B28 names
does not exist for plugins. `bb.events.on` carries exactly six thread lifecycle events
(`bb-plugin-sdk.d.ts:15716-15745`) and `thread/tokenUsage/updated` is not one of them.
So:

```ts
for (const event of ["thread.active", "thread.idle", "thread.failed"] as const) {
  bb.events.on(event, ({ thread }) => {
    dossierCache.delete(thread.id);
    signalsCache.delete(thread.id);
    bb.realtime.publish(DOSSIER_CHANNEL, { threadId: thread.id });
  });
}
bb.events.on("thread.deleted", ({ thread }) => { /* delete only, no publish */ });
```

`thread.idle` fires at the end of every turn, which is exactly when
`thread/tokenUsage/updated` last fired for that thread — so the observable behavior
B28 asks for is preserved. See the §7 ruling.

**Frontend, `src/dossier/useDossier.ts`.** A module-level
`Map<threadId, {promise, value, expiresAt}>` with the same 10s TTL. This is what makes
B27 true: a second hover inside the window renders from the map synchronously on the
first paint, with no request. `useRealtime(DOSSIER_CHANNEL, ({threadId}) => cache.delete(threadId))`
drops the entry when the backend says it went stale.

**A rejected RPC call is not a null field.** `PluginRpcClient.call` rejects on transport
failure, on a backend reload mid-hover, and on a handler throw
(`bb-plugin-sdk-app.d.ts:1542-1549`); it does not resolve with the nullable schema. The
two cases are different states and the hook models them as such:

```ts
interface DossierState {
  status: "idle" | "loading" | "ready" | "error";
  data: Dossier | null;   // populated only when status === "ready"
  error: string | null;   // populated only when status === "error"
  retry: () => void;
}
```

- `idle` before hover intent fires. No request has been made.
- `loading` while in flight. The popover renders its non-backend fields immediately
  (B27) with a skeleton for the backend ones.
- `ready` with `data`. Null *fields* inside `data` are the B31 no-data case and omit
  their sections. This is normal, not an error.
- `error` after the call rejects. The hook **retries once** automatically, then renders
  a single inline error line inside the popover plus the `retry` affordance. It never
  renders an indefinite spinner, and it never leaves an unhandled rejection: every
  cached entry's promise carries a `.catch` that writes the error state.

The cache stores rejections too, for a shorter **2s** TTL, so a backend that is down
does not get one request per hover per row while the user moves the pointer.

**"Hovering N rows issues at most N requests, never a batch on mount" (B28)** falls out
of this: `threadDossier` is called from a hover-intent timer only, never from an effect
that runs on mount. `rowSignals` is a *different* method with a different rule — see
the §7 ruling on B37-B40.

### Settings (B48-B50)

```ts
const settings = bb.settings.define({
  groupBy:   { type: "select", label: "Group by",   options: ["date", "project", "none"], default: "date" },
  secondRow: { type: "select", label: "Second row", options: ["auto", "always", "never"], default: "auto" },
  tooltip:   { type: "select", label: "Hover card", options: ["rich", "minimal", "off"], default: "rich" },
});
```

The frontend reads these through `useSettings().values` — no RPC. `src/settings.ts`
narrows the `Record<string, string | boolean>` to `BetterSidebarSettings`, falling back
to the defaults above while `isLoading` or on an unrecognized value, so a future option
added to the enum degrades to `date`/`auto`/`rich` rather than crashing the list.

---

## 6. Per-row hook cost

`experimental_useSidebarThreadPullRequest` and `experimental_useSidebarThreadSplit`
are both one call per row. The SDK's own doc comment advises windowing: *"Window your
rows (render only what is on screen) as the built-in sidebar does — a list that mounts
one row per thread is slow on phones with many threads"*
(`bb-plugin-sdk-app.d.ts:2151-2158`).

**This plugin does not window. Every row mounts, always, in visual order.**

The decision is B44's. B44 requires every row's interactive element to carry
`data-sidebar-thread-shortcut-target` and `data-sidebar-thread-id` in visual order so
bb's nine numbered shortcuts plus next/previous keep working, and it is a user-declared
non-negotiable of the host contract. A windowed list mounts targets only for the visible
range, so after scrolling to row 100 `thread.jump.1` selects the first overscanned DOM
node rather than thread 1, and `thread.next` cannot reach a row that is not mounted.
That is a silent, wrong-thread failure — a strictly worse outcome than a slow list.

The evidence says the cost is affordable. **Neither reference plugin windows.**
`.bb-refs/bb-sidebar` (12,456 lines, the richest reference) and
`.bb-refs/bb-plugin-t3sidebar` both render every row, both call per-row hooks, and both
are in daily use. Windowing here was premature optimisation bought at the price of a
non-negotiable, and it is removed.

**Retained mitigations, both in `row/`:**

1. **Conditional PR hook.** `ThreadRow` calls
   `experimental_useSidebarThreadPullRequest(thread.id)` itself, **once**, and only when
   `thread.environment !== null` — a thread with no environment can have no branch and
   therefore no PR (`bb-plugin-sdk-app.d.ts:967-971`). It passes the result down to both
   `PrChip` and `RowContextMenu` as a prop, so `PrChip` is purely presentational and
   testable without a host, and the row makes one PR hook call rather than two. On a
   typical list the `environment !== null` gate removes the majority of them entirely.
2. **Memoized rows.** `ThreadRow` is wrapped in `React.memo` over the fields it actually
   reads. Thread objects keep their identity across updates while the underlying entry
   is unchanged (`:2148-2150`), so a row re-renders only when its own thread changed —
   which is what keeps a full mount affordable as the array identity churns.

**Verification point, owned by slice 3:** a test renders 200 synthetic threads through
`renderSlot` and asserts that `container.querySelectorAll("[data-sidebar-thread-shortcut-target]")`
has **length 200** and that its `data-sidebar-thread-id` sequence equals the model's
row order exactly. That is the regression guard: if a later change reintroduces
windowing, that test fails.

**If a real 500-thread list later proves too slow**, the fix is not windowing — it is
asking the host for a shortcut-target contract that survives virtualization. Record it
as a follow-up; do not trade B44 for frame time without the user's ruling.

---

## 7. Corrections

PRODUCT.md was written before the 0.4.21 surface was probed. These are the invariants
the API cannot satisfy as literally worded. **PRODUCT.md is not edited**; this section
is the single home for the rulings, and every one preserves the stated intent.

**B28 — "invalidated by the `thread/tokenUsage/updated` realtime channel".**
No such channel is reachable from a plugin. The frontend's `useRealtime` receives only
channels this plugin publishes; the backend's `bb.events.on` accepts only the six
lifecycle names at `bb-plugin-sdk.d.ts:15716-15745`, and `thread/tokenUsage/updated` is
a *thread event row*, readable through `events.list` but not subscribable.
**Re-wording:** *"…invalidated when the thread's turn ends — the backend clears its
cache entry on `thread.active`, `thread.idle` and `thread.failed` and publishes its own
`thread-dossier` channel, which the frontend cache listens on."* Same observable
behavior: `thread.idle` fires at the moment the last token-usage event for that turn
has landed.

**B6 — "New threads that arrive while frozen append at their sorted position on release."**
Read literally this hides a newly arriving thread — including a new `NEEDS YOU` — for
up to 2s after the pointer leaves. **Re-wording:** *"A thread that arrives while frozen
renders immediately, appended to the end of the entire rendered list in arrival order;
it never displaces a frozen row, and it takes its sorted position on release."* The
intent — nothing the user is aiming at moves — is preserved exactly, because appending
past the last row is the only insertion position that cannot shift anything above it.
Appending per *section*, the earlier reading, does not preserve it: a newcomer that
creates or extends `NEEDS YOU` pushes every row of every lower section down while the
pointer is still over the list. See §4.

**B37-B40 — row-level signals implied per-row reads.** Context pressure, model
fallback, rate-limit and goal all come from thread *event rows*, four `events.list`
calls per thread. Fetching them for every mounted row would be exactly the "batch on
mount" B28 forbids, at 170 threads × 4 calls. Since every row now mounts (§6), the
bound cannot come from windowing. **Re-wording:** *"These four signals are fetched by a
batched `rowSignals` request covering only the thread ids currently visible in the
viewport (≤60 per request), tracked with an `IntersectionObserver` on the mounted rows,
refreshed when the visible set changes and on the `thread-dossier` invalidation channel.
A row that has never been scrolled into view draws no signal glyph until it is."*
Rows stay mounted and keep their shortcut targets (B44); only the signal *fetch* is
bounded. A glyph the user has not yet scrolled to costs nothing to omit.

**B39 — "renders as its own state, distinct from idle."** §4's five-state table is
driven by `thread.indicator`, whose union has no rate-limit member
(`bb-plugin-sdk-app.d.ts:886`). **Re-wording:** *"Rate-limit-paused renders as an extra
monochrome glyph in the row's signal cluster, alongside the context-pressure and
fallback glyphs — not as a sixth value of the §4 indicator table, which stays as
written."*

**B23 — "filled with `strings.iconTint.light` / `.dark` per theme."**
`strings` is optional and `iconTint` is optional inside it, so a provider can serve a
logo with no tint. B24 covers only the no-logo case. **Re-wording:** *"A provider with a
logo but no `iconTint` is filled with `bg-muted-foreground/70`, matching every other
monochrome glyph in the row."* (This is what `.bb-refs/bb-sidebar/src/ProviderGlyph.tsx`
already does.)

**B29 — "model · reasoning effort".** `defaultExecutionOptions` returns `null` for a
thread that has never resolved options (`bb-plugin-sdk.d.ts:15240`). **Re-wording:**
*"…model and reasoning effort when the thread has resolved execution options; both
lines are omitted together when it has not, the same way B31 omits economics."*

**B16 — "→ worktree name → …".** The only worktree-shaped fields are
`environment.name` and `environment.workspaceDisplayKind`
(`bb-plugin-sdk-app.d.ts:936-941`); `environment` itself is nullable, as is `host`.
**Re-wording:** *"`environment.branchName` → `environment.name` when
`workspaceDisplayKind` is `managed-worktree` or `unmanaged-worktree` → `host.name` →
omitted, and the whole chain is skipped when `environment` is null."*

**B36 — "Clicking opens the PR URL in a new tab."** The plugin has no way to promise a
new tab. The host's `openUrl` opens according to the client's own browser preference
and returns a boolean the caller must honour (`bb-plugin-sdk-app.d.ts:2107-2111`); the
plugin never gets to choose the target. **Re-wording:** *"Clicking opens the PR through
the host's `openUrl`, which honours the client's own browser preference rather than
guaranteeing a new tab, and it never navigates the thread (`stopPropagation`). A falsy
return surfaces as a toast rather than failing silently."* The intent — the PR opens
somewhere else, the thread does not change — is preserved; only the guarantee the
plugin cannot make is dropped.

**B42 — "chosen so they do not collide with bb's nine existing sidebar shortcuts."**
No test can prove this. `bb-plugin-sdk.d.ts:105-129` enumerates *command identifiers*
(`thread.jump.1`, `thread.next`, …) and separately models configurable shortcut
objects; the effective key bindings are user-configurable server-side and are not
readable from a plugin. A test asserting "the table contains no `1`-`9`, `n` or `p`"
compares against command names, not bindings, and would pass while colliding.
**Re-wording:** *"Bucket-jump shortcuts are chosen to be collision-free **by
construction**: every binding is modifier-qualified (`Alt+ArrowUp` / `Alt+ArrowDown`
for section jump, the modifier idiom `bb-tinted-threads` already uses for row
reorder), and the table contains no bare alphanumeric key."* The test asserts that
structural property — every entry modifier-qualified, none bare — which is provable,
rather than a collision-freedom that is not. **Recorded limitation:** a user who
deliberately rebinds a host command onto `Alt+Arrow` can still collide. That is outside
the plugin's control and outside its ability to detect.

**B41 vs B14 — a named tension, resolved rather than corrected.** B14 forbids opacity as
a carrier ("a resting row is never faded"); B41 asks for an opacity gradient across
buckets. They encode different axes, so both hold under one constraint:
**the B41 gradient applies to the row's second line and its section header only, never
to the row-1 title, and `NEEDS YOU`, `PINNED`, `TODAY` and the search list are all
`dimLevel: 0`.** `dimLevel` floors at 3 (`opacity-70`) so `OLDER` stays legible. No row
in a section the user is working in is ever faded, and unread is still carried by font
weight alone.

**No invariant was found unsatisfiable.** Every one of B1-B50 has an implementation
path in this spec.

---

## 8. Slice plan

Six slices, each one implementer's whole job, running **in parallel in one worktree**.
Ownership is disjoint at file granularity, and no slice owns `package.json`,
`tsconfig.json`, `vitest.config.ts`, `marketplace.json`, `PRODUCT.md`, `LEDGER.md`, or
this file. Cross-slice *imports* are expected; cross-slice *writes* are not.

Five files are shared infrastructure that other slices import. Slice 2 owns them and
**lands them as its first commit**, before its own component work; their full contents
are fixed here so the other slices can code against the signature without waiting:

- `src/lib/utils.ts` — `export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }`
- `src/lib/portal-scope.ts` — verbatim from
  `.bb-refs/bb-sidebar/src/lib/portal-scope.ts` (see §9).
- `src/lib/local-store.ts` — `readStore<T>(key, schema, fallback): T` and
  `writeStore<T>(key, value): void`, namespaced under `better-sidebar:`, zod-validated,
  never throwing.
- `src/ui/HoverPopover.tsx` — `({open, onOpenChange, trigger, children, side})`,
  a Radix `HoverCard.Root` in controlled mode whose `Content` spreads
  `usePortalScopeProps()`.
- `src/ui/Glyph.tsx` — inline-SVG glyph primitives, `({name, className, ...aria})`.

**Four cross-slice component seams**, each a fixed signature so no slice edits
another's file. `ThreadRow` (slice 3) is the integration point for all four:

| Component | Owned by | Fixed signature |
| --- | --- | --- |
| `RowHover` | 4 | `({threadId, children}) => ReactNode` — wraps the row's content and owns the hover trigger, so slice 4 never edits `ThreadRow.tsx` |
| `RowSignals` | 4 | `({threadId}) => ReactNode` |
| `RowContextMenu` | 6 | `({thread, pullRequest, onNavigate, renameEditor, children}) => ReactNode` |
| `useRenameEditor` | 6 | `(threadId) => {isRenaming, inputProps, start, cancel}` — slice 3 renders the input, slice 6 owns the state and the `actions.rename` call |

Verification command for every slice, from `plugins/better-sidebar/`:

```
npx tsc --noEmit && npx vitest run
```

`tsc` is ~4s and `vitest` <1s, so it is cheap enough to run per edit. Slices 2 and 5
additionally run `bb plugin build .` (~3s) once at the end.

---

### Slice 1 — List model

**Scope.** The pure list seam: bucketing, precedence, sort, nesting, search ranking,
dim levels, title and workspace-label resolution, and the freeze overlay's data
transformation.

**Owns**
```
src/model/types.ts
src/model/buckets.ts
src/model/list-model.ts
src/model/search.ts
src/model/buckets.test.ts
src/model/list-model.test.ts
src/model/search.test.ts
```

**Satisfies** B1, B2, B4, B5, B8, B9, B11, B13, B16, B41, B43.

**Blocked by** nothing. Start immediately.

**Test points.** A thread that is both `hasPendingInteraction` and `isPinned` appears
once, in `needs-you` (B1). A `latestAttentionAt` one millisecond before local midnight
buckets as `yesterday` when `now` is one millisecond after (B2) — use fixed epoch
values, never `Date.now()`. An empty section produces no `RenderSection` (B4). A child
of a `pinned` parent renders inside `pinned` at `depth: 1` (B9). An archived child of
an expanded parent is visible; the same child under a collapsed parent is not (B11).
Every `groupBy` value keeps `needs-you` and `pinned` first (B8). Non-empty
`searchQuery` yields exactly one section, all `depth: 0`, all `projectName` non-null
(B43). `title` resolves through all three arms — `title`, then `titleFallback`, then
`"Untitled"` — including the whitespace-only-title case (B13). `workspaceLabel` walks
the full §7 chain and yields `null` for `environment: null` without throwing (B16).
Freeze overlay: a frozen id keeps its index when its `latestAttentionAt` overtakes the
row above it; a section that emptied keeps its position; and — **the load-bearing
case** — a newly arriving `hasPendingInteraction` thread lands at the very end of the
whole list and leaves every existing row's index byte-identical (§4 points 1-5). No
test in this slice imports React or sets a vitest environment.

**Verify.** `npx tsc --noEmit && npx vitest run`

---

### Slice 2 — Shell, freeze, settings, shared UI

**Scope.** The slot component, the freeze state machine, the clock, localStorage-backed
collapse, settings parsing, the four list-level states, and the five shared
infrastructure files.

**Owns**
```
app.tsx
src/ThreadList.tsx
src/ListStates.tsx
src/useFreeze.ts
src/useNow.ts
src/useCollapse.ts
src/settings.ts
src/lib/utils.ts
src/lib/portal-scope.ts
src/lib/local-store.ts
src/ui/HoverPopover.tsx
src/ui/Glyph.tsx
src/ThreadList.test.tsx
src/ListStates.test.tsx
src/useFreeze.test.tsx
src/useCollapse.test.ts
src/settings.test.ts
```

**Satisfies** B3, B6, B7, B10, B18, B19, B47, B48, B49, B50.

**Blocked by** slice 1 (`buildListModel`, `src/model/types.ts`) and slice 3
(`ThreadList` imports `ThreadRow`). It is **no longer blocked by slice 5** — collapse
moved to `localStorage`, so slice 2 touches no RPC at all. Compile-time only; write
against §3's signatures from minute one. Slice 2 is last in compile order (see the
dependency graph), which is expected — it is the integration point.

**Test points.** `useNow` re-partitions across a simulated local midnight without a
data change, via `vi.setSystemTime` plus `vi.advanceTimersByTime` (B3). Collapsing
`LAST 7 DAYS` hides its rows and survives a remount by reading back from
`localStorage`; a corrupt or absent stored value yields "nothing collapsed" rather than
a throw; its header shows the contained count; `NEEDS YOU` and `PINNED` render no
collapse control (B7). A parent chevron shows the child count and collapses the
subtree, persisted the same way (B10).

**The four list states, four tests, each a named branch in `ListStates.tsx`** —
`experimental_useSidebarThreads()` reports `status: "loading" | "error" | "ready"`
(`bb-plugin-sdk-app.d.ts:986-990`) and a blank sidebar is never an acceptable rendering
of any of them:

- **loading** — `{status: "loading"}` renders skeleton rows, not an empty container.
- **error** — `{status: "error"}` renders an inline message plus a retry affordance.
- **empty** — `{status: "ready", threads: []}` with an empty `searchQuery` renders a
  New-thread hint.
- **no matches** — `{status: "ready"}` with a non-empty `searchQuery` that matches
  nothing renders distinct copy naming the query.

Each test asserts its own distinguishing copy is present *and* that the other three
branches' copy is absent, so the four can never collapse into one.

`secondRow: "auto"` renders row 2 under `groupBy: "date"` and `"none"` and hides it
under `"project"`; `"always"` and `"never"` override in all three (B18). Row 2 still
renders with `isCompactViewport: true` (B19). Opening a thread calls `onNavigate` —
assert through `inspection.sidebarActionCalls` plus a spy prop (B47). Settings absent
(`values: undefined`) falls back to `date`/`auto`/`rich` (B48-B50). Freeze: the full
state machine per §4, including that COOLDOWN→FROZEN keeps the old snapshot and that a
`searchQuery` change releases immediately. Slice 2 also runs `bb plugin build .` once
to confirm the slot still registers.

**Verify.** `npx tsc --noEmit && npx vitest run`, then `bb plugin build .`

---

### Slice 3 — Row chrome

**Scope.** Everything a row draws: both lines, the five-state glyph, the provider
glyph, the PR chip and its hover card, the host contract attributes, and the
integration of the four cross-slice seams.

**Owns**
```
src/row/ThreadRow.tsx
src/row/SecondRow.tsx
src/row/StatusGlyph.tsx
src/row/ProviderGlyph.tsx
src/row/PrChip.tsx
src/row/relative-time.ts
src/row/ThreadRow.test.tsx
src/row/StatusGlyph.test.tsx
src/row/ProviderGlyph.test.tsx
src/row/PrChip.test.tsx
src/row/relative-time.test.ts
```

**Satisfies** B12, B14, B15, B17, B20, B21, B22, B23, B24, B25, B33, B34, B35, B36,
B44, B45.

**Blocked by** slice 1 (`RenderRow`), slice 2 (`cn`, `HoverPopover`, `Glyph`), slice 4
(`RowHover`, `RowSignals`), slice 6 (`RowContextMenu`, `useRenameEditor`). Slice 3 is
the integration point for every cross-slice seam, so it compiles last among 3/4/6 —
write against the four fixed signatures in the §8 preamble and let `tsc` fail until
they land.

**`ThreadRow` owns the one PR hook call.** It calls
`experimental_useSidebarThreadPullRequest(thread.id)` itself, once, gated on
`thread.environment !== null`, and passes the resulting `pullRequest` down to both
`PrChip` and `RowContextMenu`. `PrChip` takes it as a prop and makes no hook call —
that is what lets B46's "open pull request" item exist without a second subscription,
and what makes `PrChip` testable without a host. `ThreadRow` also threads `onNavigate`
down from the slot props into `RowContextMenu`, and renders `useRenameEditor`'s input
in place of the title when `isRenaming` is true.

**Test points.** An `indicator` value outside the union (cast through `as never` in
the fixture) renders nothing and throws nothing (B20) — this is the future-proofing
test and it must exist. `aria-label` on the glyph equals `thread.indicatorLabel`
(B21). Only `waiting-for-input` and `unread-error` carry a colour class; `runtime`
carries `animate-pulse` and no hue (B22). `isUnread` changes only font weight — assert
no `opacity-` class appears on the row (B14). No pin glyph is rendered for
`isPinned: true` (B15). A thread with `logoUrl: null` renders the neutral dot; one with
a `logoUrl` and no `strings.iconTint` renders the masked span with
`bg-muted-foreground/70`; the accessible name is `displayName`, falling back to
`providerId` when the provider is absent from the directory (B23-B25, §7 ruling). The
provider glyph is present on a thread with no environment and no PR, so row 2's right
edge is fixed (B17). A child row shows its own relative time (B12). PR chip: renders
`#<number>` from `sidebarPullRequests`, tints per `attention` across all four cases
(`merged`, `checks_failed`/`conflicts`, `ready_to_merge`, everything else) (B33-B34);
its hover card is a rendered element and not a `title` attribute (B35); clicking calls
`openUrl` **once with the PR url** and produces **no** `open` entry in
`sidebarActionCalls`, and a falsy `openUrl` return surfaces a toast rather than failing
silently (B36, §7 ruling — the test asserts the call and the non-navigation, never
"a new tab", which the plugin cannot observe or promise); on `isCompactViewport` it
renders as a plain link with no hover card. `PrChip` renders from its `pullRequest`
prop with no host at all — assert it mounts outside `renderSlot`. Every interactive
element carries `data-sidebar-thread-shortcut-target=""` and `data-sidebar-thread-id`
(B44) and spreads `splitProps` (B45).

**The B44 guard, replacing the old windowing test:** render 200 synthetic threads and
assert `container.querySelectorAll("[data-sidebar-thread-shortcut-target]")` has length
**200**, in an order byte-identical to the model's row sequence. Every row mounts (§6);
if a later change reintroduces windowing, this fails.

**Verify.** `npx tsc --noEmit && npx vitest run`

---

### Slice 4 — Dossier and row signals

**Scope.** The row hover wrapper, the hover-intent controller, both caches on the
frontend side, the popover contents, and the four extra row signal glyphs.

**Owns**
```
src/dossier/RowHover.tsx
src/dossier/useDossier.ts
src/dossier/Dossier.tsx
src/dossier/RowSignals.tsx
src/dossier/useRowSignals.ts
src/dossier/RowHover.test.tsx
src/dossier/useDossier.test.tsx
src/dossier/Dossier.test.tsx
src/dossier/RowSignals.test.tsx
```

**Satisfies** B26, B27, B29, B30, B31, B32, B37, B38, B39, B40.

**Blocked by** slice 2 (`HoverPopover`, `Glyph`, `BetterSidebarSettings`), slice 5
(`betterSidebarRpcContract`, `dossierSchema`, `rowSignalSchema`, `DOSSIER_CHANNEL`).

**`RowHover` is this slice's integration seam**, signature
`({threadId, children}) => ReactNode`. Slice 3's `ThreadRow` wraps its row content in
it and passes nothing else; everything about hover intent, suppression, the popover and
its placement lives inside this slice's files. Without it, slice 4 would have no owned
file where the dossier attaches to a row and would have to edit `ThreadRow.tsx`, which
is slice 3's.

**Test points.** Hover opens after ~250ms and not before; a pointer-down anywhere
suppresses it, and it stays suppressed for 300ms after pointer-up (B26) — fake timers
throughout. A second hover of the same row inside the TTL renders content on the first
paint with **zero** new entries in `inspection.rpcCalls` (B27). Hovering three rows
produces exactly three `threadDossier` calls; mounting the list with 50 threads
produces zero (B28's frontend half). An `economics: null` payload omits the economics
section entirely — assert the absence of both "0" and "—" in the popover, and assert
the rest of the dossier still renders (B31). No string matching a currency figure
appears anywhere in the component tree (B30). All of B29's fields render when present.
`isCompactViewport: true` renders no dossier at any hover duration and registers no
long-press handler (B32). Row signals: `contextPressure: 0.85` draws the warning glyph
and `0.5` draws nothing and `null` draws nothing (B37); a `modelFallback` payload draws
the alert glyph and the dossier names `originalModel`, `fallbackModel` and the reason
(B38); `isRateLimitPaused` draws its own glyph distinct from the idle case (B39); a
goal with `tokenBudget` draws a ring at `tokensUsed / tokenBudget` and
`status: "budgetLimited"` draws it full (B40). `useRowSignals` sends one request for
the **viewport-visible** id set, re-requests when that set changes, and drops its cache
entry on `emitRealtime(DOSSIER_CHANNEL, {threadId})`; a row that has never intersected
requests nothing. Mock `IntersectionObserver` in the test setup — jsdom does not ship
it — and assert a row outside the observed set contributes no id to the request.

**The RPC-failure branch (§5's `DossierState`), four assertions:** a rejecting
`threadDossier` handler leaves the popover in `status: "error"` rendering a single
inline error line, renders **no** spinner, exposes a working `retry`, and produces
exactly **two** `rpcCalls` for one hover (the call plus its one automatic retry) — not
one per re-render, and not an unhandled rejection. A rejection is cached for 2s, so a
second hover inside that window adds no further call. This branch is distinct from
`economics: null`, which is `status: "ready"` with an omitted section; one test asserts
both cases side by side so they can never be conflated.

**Verify.** `npx tsc --noEmit && npx vitest run`

---

### Slice 5 — Backend

**Scope.** The RPC contract, every handler, the TTL caches, lifecycle invalidation, and
the three settings descriptors.

**Owns**
```
src/server-contract.ts
src/server.ts
src/server.test.ts
src/scaffold.test.ts        (replaced by server.test.ts; delete in this slice)
```

**Satisfies** B28.

**Blocked by** nothing. **Land `src/server-contract.ts` verbatim from §5 as the first
commit** — slice 4 is blocked on that file and on nothing else in this slice. Slice 2
no longer depends on this slice at all: collapse moved to `localStorage`, so there is
no kv store, no `readCollapse`/`setCollapse` pair, and no `COLLAPSE_CHANNEL`.

**Test points.** Through `createFakePluginHost` (the pattern already in
`src/scaffold.test.ts`). `threadDossier` on a thread with no token events returns
`economics: null` and still returns `execution` and `contextWindow` — it does not
throw (B31's backend half, and the reason B31 is a return value). A
`defaultExecutionOptions` of `null` returns `execution: null`. A second call inside the
TTL makes no second SDK call; a call after `thread.idle` fires does. `thread.idle`
publishes `DOSSIER_CHANNEL` with the thread id; `thread.deleted` evicts without
publishing. `rowSignals` with 40 ids issues **160** `events.list` calls (4 per thread,
one per event type per §5) and 0 on the second call inside the TTL; an id with no
events returns an all-null/false signal row rather than being omitted. **The
per-type-limit test:** a thread with 30 recent `thread/goal/updated` rows and one older
`provider/modelFallback` row still returns that fallback — the regression guard against
the combined-`limit` read that would drop it. Input over 60 ids is rejected by the
contract, not by the handler. Also runs `bb plugin build .` and
`bb plugin install . --yes` once at the end.

**Verify.** `npx tsc --noEmit && npx vitest run`, then `bb plugin build .`

---

### Slice 6 — Context menu and keyboard

**Scope.** The right-click menu, the inline rename editor's state, and the bucket-jump
shortcuts.

**Owns**
```
src/menu/RowContextMenu.tsx
src/menu/useRenameEditor.ts
src/menu/RowContextMenu.test.tsx
src/menu/useRenameEditor.test.tsx
src/keyboard/bucketJump.ts
src/keyboard/bucketJump.test.ts
```

**Satisfies** B42, B46.

**Blocked by** slice 2 (`portal-scope`, `Glyph`). Slice 3's `ThreadRow` wraps its
content in `<RowContextMenu>` and renders `useRenameEditor`'s input; both integrations
are slice 3's edits to slice 3's files, against the signatures fixed here.

**`RowContextMenu` signature: `{thread, pullRequest, onNavigate, renameEditor, children}`.**
Three of those are load-bearing:

- **`onNavigate`** is required by B47 — the host says it must be called after every
  open, on every viewport, or the mobile drawer stays open and the host search field
  stays active (`bb-plugin-sdk-app.d.ts:413-415`). `actions.open` accepts no callback
  (`:1014-1016`), so the menu must call `onNavigate()` itself on **both** the Open and
  the Open-in-split paths. It reaches the menu as a prop threaded from slot props
  through `ThreadList` → `ThreadRow`.
- **`pullRequest`** arrives as a prop from `ThreadRow`'s single hook call (§6), not
  from a second `experimental_useSidebarThreadPullRequest` here. The menu shows
  "Open pull request" only when it is non-null.
- **`renameEditor`** is the handle from `useRenameEditor`. **Rename is not a direct
  `actions.rename` call**: that method is silent by design and requires a title the
  menu does not have (`:1027-1028`). The menu item calls `renameEditor.start()`, which
  puts the row into an inline editor — the pattern `bb-tinted-threads` already uses.
  Enter commits through `actions.rename(threadId, title)`, Escape cancels, blur
  commits. An empty or unchanged title cancels rather than committing.

**Test points.** The menu portals with `usePortalScopeProps()` applied — assert
`data-bb-portaled-overlay` on the content node. All eight items are present and each
routes correctly: open and open in split (`open(id, {split: true})`) **each followed by
an `onNavigate` call — assert the spy fired on both paths** (B47's menu half), pin/unpin
(`setPinned`), mark read/unread (`setRead`), rename (asserts `start()` was called and
that **no** `rename` entry appears in `sidebarActionCalls` until the editor commits),
archive (`archive`), request delete (`requestDelete` — assert no silent delete path
exists), and "open pull request" present only when `pullRequest` is non-null (B46).
`useRenameEditor`: Enter commits via `actions.rename` with the typed title, Escape
leaves `sidebarActionCalls` empty, blur commits, an unchanged title is a no-op.

Bucket jump: `bucketJump.ts` exports the binding table as data plus a pure
`nextSectionIndex(current, direction, sectionCount)`. Bindings are **`Alt+ArrowUp` and
`Alt+ArrowDown`**, chosen to be collision-free by construction per the §7 B42 ruling.
The test asserts the structural property — **every entry is modifier-qualified and the
table contains no bare alphanumeric key** — and `nextSectionIndex`'s clamping at both
ends. It does **not** assert collision-freedom against host command names: effective
bindings are user-configurable server-side and unreadable from a plugin
(`bb-plugin-sdk.d.ts:105-129` enumerates command identifiers, not keys), so such a test
would pass while colliding.

**Verify.** `npx tsc --noEmit && npx vitest run`

---

### Invariant coverage

| Slice | Invariants | Count |
| --- | --- | --- |
| 1 List model | B1 B2 B4 B5 B8 B9 B11 B13 B16 B41 B43 | 11 |
| 2 Shell | B3 B6 B7 B10 B18 B19 B47 B48 B49 B50 | 10 |
| 3 Row chrome | B12 B14 B15 B17 B20 B21 B22 B23 B24 B25 B33 B34 B35 B36 B44 B45 | 16 |
| 4 Dossier | B26 B27 B29 B30 B31 B32 B37 B38 B39 B40 | 10 |
| 5 Backend | B28 | 1 |
| 6 Menu + keyboard | B42 B46 | 2 |
| | **total** | **50** |

Every id B1-B50 is claimed by exactly one slice. **None are left unclaimed.** The
rulings that reshaped ownership (`RowHover` to slice 4, `useRenameEditor` to slice 6,
the PR hook to `ThreadRow`, collapse to `localStorage`) moved *files*, not invariants —
the table is unchanged and still sums to 50.

### Dependency graph

This is the **true import graph**, not the intuitive one. `ThreadList` imports
`ThreadRow`, and `ThreadRow` imports `RowHover`, `RowSignals`, `RowContextMenu` and
`useRenameEditor`. So slice 2 compiles *last*, not second:

```
1 ──┐
    ├──► 4 ──┐
5 ──┘        ├──► 3 ──► 2
      2* ──► 6 ──┘

* slice 2's five shared-infrastructure files only (lib/, ui/), which land first
```

Compile order: **1, 5 → 4, 6 → 3 → 2.**

- **1 and 5 start cold.** Neither imports anything from another slice.
- **Slice 2's first commit is the five shared files** (`lib/utils.ts`,
  `lib/portal-scope.ts`, `lib/local-store.ts`, `ui/HoverPopover.tsx`,
  `ui/Glyph.tsx`). Slices 3, 4 and 6 need those and nothing else from slice 2, so
  landing them first unblocks everyone. Slice 2's *own* component work then compiles
  last, after slice 3.
- **Slice 3 is the integration point** and therefore compiles after 4 and 6.

Everyone writes against the fixed signatures in the §8 preamble before their
dependencies land, and `tsc` simply fails until they do — the intended, cheap signal.
Only the stated *order* was wrong before; that property is unchanged.

---

## 9. Portal scoping

Every Radix overlay this plugin renders — the dossier hover card, the PR hover card,
the row context menu, any tooltip — portals to `document.body`, which is **outside** the
plugin's mount subtree. Two things break as a result, and one file fixes both.
`src/lib/portal-scope.ts` is taken verbatim from
`.bb-refs/bb-sidebar/src/lib/portal-scope.ts`:

```ts
declare const __BB_PLUGIN_ID__: string | undefined;

export function usePortalScopeProps(): {
  "data-bb-portaled-overlay": "";
  "data-bb-plugin-root": "";
  "data-bb-plugin"?: string;
} {
  const pluginId =
    typeof __BB_PLUGIN_ID__ === "string" ? __BB_PLUGIN_ID__ : undefined;
  return {
    "data-bb-portaled-overlay": "",
    "data-bb-plugin-root": "",
    ...(pluginId === undefined ? {} : { "data-bb-plugin": pluginId }),
  };
}
```

- **`data-bb-plugin-root`** restores the plugin's style scope. The host scopes plugin
  CSS — Tailwind's preflight and the theme custom properties (`bg-popover`,
  `text-muted-foreground`, `border-border`) — under that attribute. A portalled node
  that lacks it renders with no theme variables resolved: transparent background,
  inherited body font, an unreadable overlay.
- **`data-bb-portaled-overlay`** marks the node as an interactive overlay belonging to
  a plugin. Without it the host's own outside-click and focus-management logic treats
  the overlay as a click outside the sidebar and dismisses it, or steals focus back.
- **`data-bb-plugin`** attributes the node to this plugin id for host-side debugging
  and any per-plugin CSS.
- **`__BB_PLUGIN_ID__`** is a build-time define injected by `bb plugin build`. It is
  not in the TypeScript environment, hence the `declare const` and the `typeof` guard —
  under vitest it is genuinely undefined and the function must not throw.

Spread the result onto every `*Primitive.Content` inside a `*Primitive.Portal`.
`src/ui/HoverPopover.tsx` does it once so slices 3, 4 and 6 get it for free; slice 6's
context menu does it directly. The assertion `data-bb-portaled-overlay` is present on
the content node is a test point in slices 4 and 6 — it is the cheapest possible guard
against a regression that only shows up visually.

---

## 10. Testing and validation

Every `auto`-tagged invariant resolves to a test named in §8 and to the same command:

```
cd plugins/better-sidebar && npx tsc --noEmit && npx vitest run
```

Pure-logic tests (`src/model/`, `src/row/relative-time.test.ts`,
`src/keyboard/bucketJump.test.ts`, `src/settings.test.ts`) run in the default node
environment. Component tests add `// @vitest-environment jsdom` as their first line and
mount through `loadPluginApp` + `renderSlot`, never by importing the component
directly — importing it directly binds `@get-bb/plugin-sdk/app` to an empty runtime
(`.bb-refs/bb-plugin-t3sidebar/src/ThreadInbox.test.tsx:14-17`). Backend tests use
`createFakePluginHost`. All clock-dependent tests use `vi.useFakeTimers()` with a fixed
`vi.setSystemTime`; none call `Date.now()` in an assertion.

**The six `manual` invariants** — B6, B26, B27, B35, B42, B46 — resolve to a human
verification route after `bb plugin build . && bb plugin install . --yes`, on a real
sidebar with ≥50 threads:

| Invariant | Evidence route |
| --- | --- |
| B6 freeze | Hover the list while a thread completes; the row under the cursor must not move, and neither must any row above it when a new `NEEDS YOU` thread arrives. Leave the list; order settles within ~2s. |
| B26 dossier timing | Start a split-drag from a row and confirm no popover appears during or for a beat after the drag. |
| B27 immediacy | Hover a row already hovered in the last 10s; the popover must render populated on the first frame. |
| B35 PR hover card | Hover the PR chip; a styled card appears, not a native browser tooltip. |
| B42 shortcuts | Confirm `Alt+ArrowUp`/`Alt+ArrowDown` jump between section headers and that `1`-`9`, next and previous still reach threads — including after scrolling deep into the list, since every row stays mounted (§6). |
| B46 context menu | Right-click a row; confirm all eight items, that Rename opens the inline editor rather than acting silently, that Open and Open-in-split both close the mobile drawer, and that delete opens bb's own confirmation. |

---

## 11. Risks

- **Mounting every row is a deliberate, unmeasured bet** (§6). Both reference plugins
  do it, and B44 forbids the alternative, but neither reference has been profiled at
  170+ threads either. If a real list proves slow, the levers in order are: tighten
  `React.memo`'s comparison, drop the `useSidebarThreadSplit` call for rows below the
  fold, and only then reopen B44 with the user. Do **not** silently window the list.
- **`rowSignals` is 4 `events.list` calls per visible thread.** A 60-row viewport is
  240 calls per cold batch, then nothing for 30s. Acceptable against a local server;
  if it proves not to be, the first lever is raising the TTL, the second is dropping
  B37 to dossier-only.
- **`IntersectionObserver` is the only DOM API this plugin depends on that jsdom does
  not ship.** It must be mocked in every test that mounts rows, and a missing mock
  fails loudly rather than silently disabling signals — assert the mock is installed
  in the slice 4 setup.
- **Every hook this plugin depends on is `experimental_`.** The SDK's own audit notes
  flag per-row hook cost as unresolved. A minor SDK bump can change these signatures;
  `package.json` pins `0.4.21` exactly, and that pin is deliberate.
- **`thread.idle` as a proxy for token-usage updates** (§7) will miss a mid-turn token
  update. The 10s TTL bounds the staleness, and a dossier that is up to 10s behind
  during a running turn is not a defect the user can act on.
