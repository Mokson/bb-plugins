# Phase 2 (Watch, observe mode) - QA Report

Verdict: **PASS, with pending items** (no Blocker or Fail rows; several rows
Not run per report-only guardrail; one Medium finding). Rows ran against
branch `feat/observatory` @ `f3d4c4c`, plugin reinstalled from
`/Users/mokson/Projects/Personal/bb-plugins/plugins/observatory` and
confirmed via `bb plugin list` before each observation round.

Full matrix: `docs/specs/OBS-1_observatory/qa/phase2/TESTPLAN.md` (32 rows).
Screenshots: `docs/specs/OBS-1_observatory/qa/phase2/evidence/screenshots/`.

## Phase-2 done check (plan's own acceptance line)

"a deliberately looping thread appears in the stall list within 30s with
the right rule; zero steers sent" - **MET**.

- Spawned hidden thread `thr_g7xkasurks` (claude-haiku-4-5-20251001) told to
  run `sleep 3 && ls ...` 10x as separate tool calls. `obs_signal` row for
  `repeated-identical-tool` opened at `22:18:57.899Z`, roughly 22s after
  spawn - well under 30s. Confirmed live on the Stalls page
  (`evidence/screenshots/stalls-live.png`, `stalls-live2.png`) and in the
  thread's composer banner (`thread-banner2.png`): "stalled 1s: 7 of the
  last 20 items repeat commandExecution with identical input".
- Zero steers: `select action, count(*) from obs_action group by action`
  returned `observe|261` and nothing else - no `send` action row exists
  anywhere in the store, across every probe thread run in this session.
  `watch_mode` is `observe` (confirmed via `bb observatory status --json`
  and the Settings page, `settings3.png`).

## Findings

**F1 (Medium) - stall signal never closes when its thread finishes.**
Thread `thr_g7xkasurks` reached `status: idle` (finished) but its open
`repeated-identical-tool`/`burn-no-change` `obs_signal` rows (ids 712, 713)
kept `closed_at` NULL. Nothing reconciles/closes the episode on thread
completion. Over time this leaves permanently-open signal rows for
finished threads, inflating inbox/sidebar "stalled" counts indefinitely.
Repro: `sqlite3 -readonly ~/.bb/plugins/observatory/data.db "select
id,kind,opened_at,closed_at from obs_signal where
thread_id='thr_g7xkasurks';"` - last two rows show open, no close, thread
already idle. Not a Blocker (no data loss, no steer sent) but worth a
reconcile-on-terminal-status fix before phase 3 relies on episode state.

**F2 (Low, environmental) - Observatory nav panel self-unpinned twice
during the run**, showing "This plugin panel is not available. The plugin
may have been disabled or removed." A `bb plugin install ... --yes`
reinstall recovered it each time. Given the packet's own instruction that
"sibling seats reinstall from their worktrees; last wins," this is most
likely a shared-server race with another concurrent seat's install/reload,
not a defect in this plugin's code - flagged as environmental per
guardrail 7, not a blocker.

**F3 (Medium) - trajectory page header text contradicts its own content.**
The per-thread Trajectory page prints "No rule fired on this thread."
directly above a "ladder actions" table listing 12 rule-fired rows
(`repeated-identical-tool open/closed ...`). Evidence:
`evidence/screenshots/trajectory.png`. Likely the summary line checks a
different/stale field than the ladder-actions list it renders next to.
Misleading but non-blocking (the correct data is visible just below).

**F4 (Low) - inbox/stalled scoping needs a docs clarification, not a code
fix.** PRODUCT.md commitment 25/invariant text says "inbox counts are over
all open rows." Observed behavior: the Inbox KPI row shows separate
`stalled` (watch-module opens) and `queued` (spend-module cache-miss opens)
counters rather than one blended "all modules" total - which reads as
correct per-module scoping, but doesn't literally match "over all open
rows" wording. Recommend confirming intended semantics with the spec
author; not treated as a defect since the observed split is arguably more
useful than a blended count.

## Matrix summary

32 rows total: 20 Pass, 5 Not run (report-only guardrail forbids the
mutations they'd need - toggling watch mode/module off live, forcing an
empty inbox, forcing a tree-budget-only breach, invoking the agent tool
from an agent context), 2 Partial (R5/F1, R27/F4), 0 Fail, 0 Blocked, 0
Blocker-severity findings. Full per-row detail and evidence pointers in
TESTPLAN.md.

## Invariant checks (explicit from the packet)

- Watch mode default observe: **held** (R1).
- No steer ever sent in observe mode (`obs_action` action=send count = 0):
  **held** (R3) - 261/261 rows are `observe`.
- Every action row precedes any send: **vacuously held**, no sends exist.
- Plugin never stops a thread: **held** (R25) - `watch/ladder.ts:11`
  states "nothing in this module calls `threads.send` or `threads.stop`";
  grep across watch/core source found no stop/kill call.
- Closed episode reopens as a new row when anchor recurs: **held** (R23) -
  `obs_signal` ids 707-713 for the same thread show sequential
  open/close/reopen as the evidence text changed, never a reused row.
- Tree-budget-only thread not shown as STALLED: **not exercised** (R26) -
  no tree-budget-only breach occurred in this run's data.
- Inbox counts over all open rows: **needs clarification**, see F4.
- Module toggle off silences both sweep and drain: **not exercised live**
  (R24) - report-only guardrail forbids the mutation.
- Caps 6/thread/hr, 20 overall survive plugin reload: **thresholds
  confirmed to survive reload** (R28); the caps themselves are unexercised
  since observe mode sends zero notifications (R20/R21).
- Quiet hours: **configured** (`watch_quietHours=22-07`, R22), behavior not
  exercised live.
- Density rules (one font, sizes 11/13/16/24, 24px rows, right-aligned
  numerics, no emojis, no color hierarchy): visually consistent across all
  captured screenshots - single sans font throughout, numeric columns
  (silent, cost, thresholds) right-aligned, no emoji or color-coded
  severity observed. Not pixel-measured.
- Silence timer bar is the only chart on the Stalls page: **held** -
  `stalls-live.png`/`stalls-live2.png` show one horizontal progress/timer
  bar per stalled row and no other chart type on the page.

## Human verification / out of scope

- Notification caps (6/thread/hr, 20/day overall) and quiet-hours
  live-suppression behavior need phase-3 (steer mode) or a longer soak to
  exercise for real, since observe mode never sends.
- `observatory_trajectory` agent tool: registered and its equivalent data
  verified via the UI Trajectory page (R18); not separately invoked as an
  agent tool call in this run.

## Environment / cleanup

- Plugin reinstalled and path-confirmed 3x during the run (initial, after
  F2's two panel drops); final state: `observatory@0.0.1 running`, source
  `path:/Users/mokson/Projects/Personal/bb-plugins/plugins/observatory`.
- Probe threads created (all hidden, not archived, left for inspection):
  `thr_exg4i29i67` ("Run directory listing six times"), `thr_g7xkasurks`
  and `thr_2x9ns8z9xg` ("Run repeated directory listing"). All reached
  `status: idle` (finished normally); none were stopped by this run or by
  the plugin.
- No code, config, or DB writes made by this QA seat; `data.db` accessed
  read-only throughout (`sqlite3 -readonly`).
- `git status` in the repo shows only the new `qa/` folder under this
  plugin's spec directory - no other changes.
