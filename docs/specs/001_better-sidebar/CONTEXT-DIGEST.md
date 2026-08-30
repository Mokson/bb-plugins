# Context digest — better-sidebar

The hand-forward every fix wave needs, merged from the six implementer Returns.
Values, not prose.

## Layout

`plugins/better-sidebar/` — run every command from here.

- `app.tsx` — slot registration (slice 2b)
- `src/model/` — `types.ts` seam · `buckets.ts` dates · `list-model.ts` assembly ·
  `search.ts` ranking. Pure: imports no React, sets no vitest environment.
- `src/row/` — `ThreadRow.tsx` integration · `SecondRow.tsx` metadata ·
  `StatusGlyph.tsx` state + `TRAILING_GLYPH_BOX_CLASS` · `ProviderGlyph.tsx` ·
  `PrChip.tsx` · `relative-time.ts`
- `src/dossier/` — `RowHover.tsx` seam + `CompactViewportProvider` ·
  `useDossier.ts` cache · `Dossier.tsx` contents · `RowSignals.tsx` glyphs ·
  `useRowSignals.ts` batch
- `src/menu/` — `RowContextMenu.tsx` · `useRenameEditor.ts`
- `src/keyboard/bucketJump.ts` — binding table + `nextSectionIndex`
- `src/lib/` — `utils.ts` (`cn`) · `portal-scope.ts` · `local-store.ts`
- `src/ui/` — `HoverPopover.tsx` (controlled) · `Glyph.tsx` (inline SVG index)
- `src/server-contract.ts` · `src/server.ts` · `src/server.test.ts`

## Facts the specs did not carry

- bb 0.40.0 embeds SDK **0.4.21**, not npm's 0.4.28. A higher `engines.bbPluginSdk`
  floor installs as `incompatible` and never loads.
- **No icon library.** `@hugeicons` is not a dependency. Every glyph is an inline SVG
  path in `src/ui/Glyph.tsx`, which is a shared index with exactly one writer.
- **`sonner` IS available** and bb's own sidebar imports `toast` from it in four
  files. An earlier Return wrongly concluded no toast API exists — it grepped the
  SDK `.d.ts` rather than the shimmed packages.
- `bb.events.on` has only six lifecycle names; there is no `thread/tokenUsage/updated`
  subscription. `bb.realtime.publish` is the plugin's own channel.
- Token/context data: `bb.sdk.threads.events.list`, one call **per event type**.
  Model/effort: `bb.sdk.threads.defaultExecutionOptions`, returns `null` for a thread
  that never resolved options.
- `experimental_useProviders` is a context read, safe per row. Only the PR hook needs
  the `environment !== null` gate.
- Providers carry `displayName` (no `name`), nullable `logoUrl`, and independently
  optional `strings.iconTint`.
- `navigate.openUrl(url)` returns `boolean`. The test harness leaves it **falsy**
  unless a test passes `openUrl: () => true` — a success test that omits it silently
  exercises the failure path.

## Testing

- `@get-bb/plugin-sdk/app` binds exports at module load: call
  `installTestPluginRuntime()`, then `await import()` the component.
- `renderSlot` accepts a bare `{component}` — no `app.tsx` registration needed.
- `vitest.config.ts` sets **no** environment; a DOM test needs a
  `// @vitest-environment jsdom` docblock.
- React does not listen to `pointerenter`; fire `pointerOver` / `pointerOut`.
- Timers scheduled inside a `vi.advanceTimersByTime` window do not fire in that same
  call — split the advance.
- Radix context menus open in jsdom with `fireEvent.contextMenu`; no pointer shims.
- jsdom has no `IntersectionObserver` and no `matchMedia`. This TS lib requires
  `scrollMargin` on an `IntersectionObserver` stub.
- Module state outliving `cleanup()` has explicit seams: `resetDossierCache`,
  `resetRowSignals`, `resetHoverSuppression`.
- `vi.mock("@get-bb/plugin-sdk/app", importOriginal)` is what makes B45 observable —
  the harness reports empty `splitProps`.
- Backend: drive with `harness.callRpc` / `harness.emitThreadEvent`; assert with
  `harness.inspection.sdk.callsTo("threads.events.list")` and `.realtimeSignals`.
- Test seams in the DOM: `data-better-sidebar-provider`, `data-better-sidebar-pr`.
- Two nested Radix `asChild` triggers need one real DOM element between them — this
  dictates the row's structure.
- `vi.fn()` mocks are **not** auto-cleared between tests; clear them in `beforeEach`.

## Verification

From `plugins/better-sidebar/`, all requiring `dangerouslyDisableSandbox` — the Bash
sandbox blocks vitest's `node_modules/.vite-temp` writes and `.git/index.lock`:

- `npx tsc --noEmit` — ~5s
- `npx vitest run` — ~1.5s, 18 files
- scoped: `npx vitest run src/<dir>/` — ~1s
- `bb plugin build .` — ~3s
- `bb plugin install . --yes` — ~3s
