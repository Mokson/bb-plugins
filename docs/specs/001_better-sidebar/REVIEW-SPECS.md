Max,

**BLOCKER**

- **Hidden dossier integration file** - `TECH.md:702-727,754-773` assigns `ThreadRow.tsx` to slice 3 but gives slice 4 no owned file where `Dossier` or `useDossier` can be attached to a row. Failure scenario: slice 4 finishes every owned file, yet no row mounts its hover trigger; editing `ThreadRow.tsx` to finish B26-B32 collides with slice 3.

- **Windowing breaks the host shortcut contract** - `PRODUCT.md:186-188` requires every row target in visual order, while `TECH.md:487-511` mounts at most 60 targets and records the divergence outside §7. Failure scenario: after scrolling to row 100, jump 1 selects the first overscanned DOM row instead of thread 1, and next cannot reach an unmounted row beyond the current window.

- **Rename has no input path** - `PRODUCT.md:191-194` requires Rename, but `TECH.md:850-855` routes it directly to `rename`, whose actual signature requires both `threadId` and a new title and explicitly provides no dialog (`bb-plugin-sdk-app.d.ts:1027-1028`). Failure scenario: clicking Rename has no value to pass, producing either a type error, a no-op, or an arbitrary title.

- **Context-menu opens cannot satisfy B47** - `PRODUCT.md:195-196` requires `onNavigate()` after every open, but the fixed context-menu signature in `TECH.md:846-855` contains only `{thread, pullRequestUrl}`; the SDK exposes `onNavigate` only through slot props and says it must always be called (`bb-plugin-sdk-app.d.ts:413-415`), while `actions.open` accepts no callback (`bb-plugin-sdk-app.d.ts:1014-1016`). Failure scenario: choosing Open or Open in split on mobile leaves the drawer open and the host search active.

- **The PR URL cannot reach the context menu without duplicating or moving the hook** - `TECH.md:494-498` puts the per-thread PR hook inside `PrChip`, while `TECH.md:846-855` requires `ThreadRow` to pass `pullRequestUrl` into `RowContextMenu`; the SDK exposes that data only through `experimental_useSidebarThreadPullRequest(threadId)` (`bb-plugin-sdk-app.d.ts:2162-2172`). Failure scenario: a row displays PR #42, but its context menu omits Open pull request unless `ThreadRow` makes a second hook call or the planned ownership is changed.

- **`openUrl` does not promise a new tab** - `PRODUCT.md:156-158` requires a new tab, but `TECH.md:743-745` verifies only `openUrl`, whose SDK contract opens according to the client's browser preference and can return false (`bb-plugin-sdk-app.d.ts:2107-2111`). Failure scenario: a client configured for another browser target does not open a new tab, or a rejected URL opens nothing.

- **Shortcut collision verification tests command names as if they were keys** - `PRODUCT.md:175-176` requires collision-free keys, but `TECH.md:856-860` derives `1`-`9`, `n`, and `p` from declarations that enumerate command identifiers and separately model configurable shortcut objects, not the effective bindings (`bb-plugin-sdk.d.ts:105-129`). Failure scenario: a user or host default binds one bucket-jump choice to an existing command, while the proposed literal-list test still passes.

**MAJOR**

- **The freeze correction moves existing rows** - `PRODUCT.md:34-37` freezes rendered order, but `TECH.md:280-289,532-538` inserts newcomers after the last frozen row of their live section and incorrectly claims this moves nothing. Failure scenario: a new Needs You thread creates or extends the top section and shifts every frozen row in all lower sections while the pointer remains over the list.

- **Combined `limit:"25"` can erase durable signals** - `PRODUCT.md:164-172` requires fallback, context, rate-limit, and goal signals, while `TECH.md:409-410` requests only the newest 25 events across five types; the API applies one overall `limit` to the filtered list (`bb-plugin-sdk.d.ts:15329-15340`). Failure scenario: 26 recent goal or rate-limit updates push an older model-fallback or context event outside the result, so its required glyph disappears.

- **RPC failure is mistaken for nullable data** - `TECH.md:413-415` says the dossier can render around fields after a genuine SDK failure, but failed RPC calls reject rather than returning the nullable schema (`bb-plugin-sdk-app.d.ts:1542-1549`). Failure scenario: `events.list` fails, the backend reloads during hover, or a slow in-flight call rejects, leaving an unhandled promise or permanently loading dossier because no error or retry state is specified.

- **Thread loading, failure, and whole-list empty states are undefined** - `TECH.md:68-93,684-696` defines no branch or test for the hook's `loading | error | ready` states (`bb-plugin-sdk-app.d.ts:986-990`). Failure scenario: a startup or backend error supplies an empty array and the replacement sidebar appears blank with no distinction between loading, failure, no threads, and no search matches.

- **The declared dependency graph is not the actual import graph** - `TECH.md:680-682,725-727,772-773,880-891` claims an acyclic `1/5 -> 2 -> 3/4/6` graph, but slice 2's `ThreadList` must import slice 3's row, and slice 3 imports slice 4 and slice 6 components. Failure scenario: slice 2 cannot pass its per-slice `tsc` before slice 3, while slice 3 is declared blocked by slice 2 and cannot pass until slices 4 and 6 land.

- **B13 and B16 are assigned to a slice that owns no rendering code** - `PRODUCT.md:69,76-77` defines title and workspace rendering, but `TECH.md:623-649,866-878` assigns both to the pure model even though `RenderRow` carries the raw thread and no resolved title or workspace field (`TECH.md:158-168`). Failure scenario: slice 1 cannot write the promised tests or implementation, while slice 3 may omit both because neither invariant is assigned to it.

**MINOR**

- **Manual-test accounting is internally false** - `TECH.md:960-970` says there are five manual invariants but lists six: B6, B26, B27, B35, B42, and B46. Failure scenario: scheduling or reporting based on the stated count drops one required manual route.

**Simpler-approach question**

Why retain `readCollapse`/`setCollapse`, backend KV state, and a realtime channel (`TECH.md:373-396,409-411`) for client-only collapse preferences when a namespaced, validated `localStorage` set satisfies the persistence requirement and the working reference already uses that pattern (`.bb-refs/bb-sidebar/src/ThreadInbox.tsx:90-104`)?

**Coverage**

Read fully: `docs/specs/001_better-sidebar/PRODUCT.md`, `docs/specs/001_better-sidebar/TECH.md`, and `plugins/better-sidebar/package.json`; skimmed with targeted declaration or implementation reads: both bundled `.d.ts` files, `.bb-refs/bb-sidebar/src/ThreadInbox.tsx`, `useInboxReorder.ts`, `server.ts`, and `.bb-refs/bb-plugin-t3sidebar/src/ThreadInbox.tsx`, `ThreadCard.tsx`.

**Mechanical invariant count**

The six `Satisfies` declarations contain 50 IDs, 50 unique: no syntactically double-claimed or unclaimed B1-B50 IDs.
