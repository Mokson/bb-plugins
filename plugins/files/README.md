# Files

Workspace file explorer and viewer in the thread right panel, t3code-style.

## What it does

- **Files action** in the thread right panel: file viewer on the left,
  workspace tree on the right (flattened single-child chains, search with
  match counts and Esc-to-clear, expand/collapse, refresh, draggable divider
  with persisted width, double-click to reset, arrow keys when focused).
  Rows share one layout - fixed chevron slot, extension-grouped glyph
  (folder open/closed, code, doc, image, generic file), truncated label -
  so files and folders align at the same depth.
- **Viewer**: markdown rendering (rendered by default, eye/code toggle for
  source), syntax-highlighted source via BB's host components, image preview
  served as confined preview URLs (no size cap),
  1 MB truncation banner for text, and text editing with save behind a
  compare-and-swap guard (conflicts surface instead of clobbering). The opened
  file persists per thread across tab switches.
- **Drag and drop**: drag any file or folder row into chat to drop an
  `@path` mention. Row buttons still offer copy-mention and add-to-chat.
- **File opener** for common code/text extensions, reusing the same viewer
  inside BB's preview tabs. Non-workspace sources keep BB's built-in preview.
- The environment's uncommitted-diff endpoint (`changed`) stays in the RPC
  contract but is not displayed in this version.

## RPC

`tree`, `read`, `save`, `search`, `changed` — all scoped to a `threadId`.
The backend resolves the thread's environment (host, workspace root) from
`bb.sdk.threads.get` and confines every host call beneath that root. Paths
are validated at the boundary (relative, no `..`, no absolute).
