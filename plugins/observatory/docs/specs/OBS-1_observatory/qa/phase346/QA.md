# QA Report — Observatory Phase 3/4/6

Verdict: **NOT READY** (Phase 3), **NOT READY** (Phase 4), **READY with gaps** (Phase 6).
Ran against bb-plugins feat/observatory HEAD c2dd176, plugin installed from
plugins/observatory (confirmed `bb plugin list`).

## Environmental note
Packet's spec path `docs/specs/OBS-1_observatory/` does not exist; actual location is
`plugins/observatory/docs/specs/OBS-1_observatory/`. Used the real path.

## Blockers / High

1. **[High] P3-6 command palette has no "Steer stalled thread" command.** Repro:
   Cmd+Shift+P → type "steer" → "No matching commands"
   (qa/phase346/evidence/screenshots/p3-palette3.png). The `>` palette lists only
   generic nav/window commands (p3-palette2.png); the `Cmd+K` palette is a thread-content
   search, not a command surface (p3-palette.png).
2. **[High] P4-8 `observatory_audit_pack` RPC endpoint returns 404 `unknown_method`.**
   `POST /api/v1/plugins/observatory/rpc/observatory_audit_pack` → `{"ok":false,"error":
   {"code":"unknown_method"...}}`. No CLI equivalent found in `bb observatory audit --help`.
   Cannot verify the <4096-char contract (c10) at all through any exposed surface.
3. **[Blocked, contradiction — not a product defect] P3-3 manual steer.** The packet asked
   to run `bb observatory watch steer <id>` while switching nothing globally. The CLI
   refused: `watch mode is observe; set it to steer first` (exit 1). Manual steer is gated
   on the global `watch_mode` setting, not per-invocation — so the packet's own
   instructions ("switch nothing globally" + "run watch steer") are mutually
   exclusive on this build. Did not flip the global setting to force it through, per the
   packet's own constraint. This leaves c8 (steer-before-send timestamp ordering)
   unverified this run.

## Passes worth noting
- P3-1/P3-5: watch_mode defaults to `observe` (CLI + Settings radio, screenshot
  p3-settings-2.png); quiet hours "22-07" and thresholds table visible on Settings.
- P3-2: pre-test `obs_action` table holds 502 rows, all `action='observe'`, zero
  steer/escalate (sqlite3 -readonly).
- P3-8 (F1 regression F3): source `src/app/lib/trajectory.ts:113` only returns "No rule
  fired on this thread." when `firedSignals === 0`; regression test at
  `test/watch-trajectory-markers-and-waste.test.ts:161` asserts the string never appears
  above fired rows. Could not execute the suite (pnpm blocked on unapproved native
  build scripts — environmental, not product) so this is code evidence, not a live run.
- P4-1: `bb observatory context --cwd` totals differ (29,866 vs 30,359 est tokens) across
  bb-plugins vs random cwd; calibration footnote carries `provider`, `calibrationFactor`,
  `calibrationError`; AGENTS.md/CLAUDE.md cross-reported via `duplicateOf`.
- P4-7: `bb observatory audit thr_63f4xdi75r --export` wrote exactly audit.json, audit.md,
  COST.md into the resolved run folder (bb-plugin-conductor's CND-1 spec dir) — no other
  files touched (verified with -newer against a pre-run timestamp marker).
- P6-2: distillery queue `?fixture=1` shows one card at a time; `?` cheat sheet lists
  j/k/a/e/r/s exactly as the packet specifies (p6-distill-shortcuts.png).
- P6-3: did not run `distill draft`; no thread spawned as a side effect of scan/list.
- P6-4: `corrections.preview_redacted` (517 rows) has zero matches for email, `/Users/`
  or `/home/` paths, or `[A-Z]{2,6}-[0-9]+`; max length 593 (<1200 cap).
- P6-5: `distill scan` re-run isolated (before/after `find ~/.agents/skills -type f -exec
  shasum {} + | shasum`) is hash-stable. An initial mismatch traced to unrelated,
  pre-existing uncommitted edits in `~/.agents/skills` (mtimes 07:51, before this session's
  first hash capture) — not caused by scan. No "apply" action exists in the panel's
  keyboard-shortcut sheet, consistent with apply being CLI-only.

## Not run (budget / no live fixture, not defects)
P3-4 (no live stalled thread to exercise Stalls-page confirmation), P3-7 (no thread
currently both idle and holding an open watch signal — DB shows 0 open watch signals at
test time, consistent with but not proof of the fix), P4-2/P4-5/P4-6 (Context/Audit
sub-routes not exercised within budget), P6-1 `show` (queue empty, no draft id to target).

## Verdict detail
- Phase 3: **NOT READY** — P3-6 Fail (missing palette command) plus P3-3 Blocked leaves
  c7/c8 (the phase's own acceptance criteria) unverified; enforcement-adjacent surface.
- Phase 4: **NOT READY** — P4-8 Fail; c10 (`observatory_audit_pack` return contract) has
  no working call path found.
- Phase 6: **READY with gaps** — all executed rows Pass; P6-1 `show` and P4-adjacent
  sub-routes not run, non-blocking.

Evidence: /Users/mokson/Projects/random/qa/phase346/evidence/screenshots/
