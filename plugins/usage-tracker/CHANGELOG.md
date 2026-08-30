# Changelog

All notable changes to Usage Tracker are documented here.

## Unreleased

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
