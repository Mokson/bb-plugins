# Changelog

All notable changes to Usage Tracker are documented here.

## 0.3.0 - 2026-09-04

### Changed

- Expanded usage now opens one popover above the footer, opened from a single
  clickable strip area, listing every enabled provider with all of its limit
  windows as aligned inline mini bars; selecting a row slides to that
  provider's full detail view with a back button. Escape steps back from the
  detail view before closing.
- Each provider row shows the 5-hour and weekly reset countdowns next to the
  name, separated by a dot, and the last-updated time reads as a relative
  age ("Updated 1m ago") next to the refresh and close buttons.
- The popover adapts to narrow viewports and bb's mobile drawer, wrapping
  countdown chips and capping its width to the footer instead of clipping.
- The OpenCode Go mark is the official pixel-style glyph from opencode.ai,
  and the strip's responsive tier ladder extends to three providers.

## 0.2.0 - 2026-09-04

### Added

- OpenCode Go usage in the sidebar footer, read directly from OpenCode's Zen
  usage endpoint with the API key stored under Settings → Plugins → Usage
  Tracker. The expanded view shows the 5-hour, weekly, and monthly limit
  windows with reset times; a missing, rejected, or rate-limited key falls
  back to a recovery message while last-known values stay visible.

## 0.1.3 - 2026-08-27

### Added

- A Compact limit setting chooses whether the collapsed percentage and
  progress bar show weekly or five-hour usage. Weekly is the default.
  Contributed by [Stephen Dolan (@stephendolan)](https://github.com/stephendolan).

### Fixed

- Read the current BB provider keys for Claude Code and Cursor while preserving
  compatibility with legacy keys, and isolate an omitted provider instead of
  failing the complete usage snapshot.
- Show and retain every additional provider usage window after the canonical
  five-hour and weekly rows, with responsive scrolling, accessible focus, and
  reliable close, refresh, and Escape behavior.

## 0.1.2 - 2026-08-17

### Changed

- Migrated development types to the pinned `@get-bb/plugin-sdk` development
  dependency and raised the minimum BB version to 0.38.

## 0.1.1 - 2026-08-12

### Added

- Independent settings for showing or hiding Claude Code and Codex usage in
  the sidebar footer. Both providers remain enabled by default.

### Changed

- Provider visibility updates live after settings are saved, and the compact
  strip adapts its layout when only one provider is enabled.
- A single enabled provider now forms a compact right-aligned group with its
  refresh control, rather than retaining the full two-provider width.
- Disabling both providers hides the Usage Tracker sidebar row.

## 0.1.0 - 2026-08-11

### Added

- Initial release with compact Claude Code and Codex five-hour and weekly
  usage limits, expandable reset details, manual refresh, and last-known value
  retention.
