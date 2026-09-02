# Phase 2 (Watch, observe mode) - Test Plan

Branch feat/observatory @ f3d4c4c. Source: PRODUCT.md (watch/notifications
sections, commitments 6,7,21-25,36, c6-c8), TECH.md, plan's phase-2 done
check: "a deliberately looping thread appears in the stall list within 30s
with the right rule; zero steers sent."

## Requirements digest (commitments -> rows)

- C6 watch_mode defaults to observe; in observe: record signals, send
  nothing; off: record nothing; KV override outranks setting -> R1, R2
- C7 every obs_action row for a send precedes the send call; failed send
  still recorded -> R3 (no send rows exist in observe mode, so tested as
  "no send action exists")
- C21 seven watch rules with defaults: silence-no-inflight 4m,
  repeated-identical-tool 3/20, read-edit-read oscillation 2 cycles,
  active-no-turn 10m, burn-no-change 150k tokens, retry-storm 3/10m,
  tree-budget 50/500 usd -> R4-R10
- C22 steer ladder (rung 0 record only in observe) -> R11 (rung 0 only,
  rungs 1-3 are phase 3, out of scope, boundary row)
- C23 tree budget cannot veto a spawn; breach steers parent (phase 3,
  boundary row since mode=observe means no steer sent) -> R12
- C25 attention inbox ranks open signals, one evidence line each, empty
  state when none -> R13, R14
- C33 nav panel "Observatory", routes inbox/stalls/per-thread trajectory/
  settings -> R15-R19
- C36 notification caps 6/thread/hr, 20 overall, quiet hours, silent for
  viewed thread, stalled fires once per episode + re-arms on new item
  (episode reopen = new row) -> R20-R23

## Non-goals / boundaries

- G1: module toggle off silences both sweep and drain paths -> R24
- G2: plugin never stops a thread -> R25 (adversarial/invariant)
- G3: tree-budget-only breach shown as STALLED -> R26 (must be false)
- G4: inbox counts are over ALL open rows, not just watch -> R27
- G5: caps survive plugin reload -> R28

## Matrix

| ID | Origin | Area | Steps | Expected | Persona | Oracle | Status |
|----|--------|------|-------|----------|---------|--------|--------|
| R1 | requirement | watch mode default | `bb observatory status --json` settings | watch_mode = observe | owner | machine | PASS - status shows `watch_mode observe` |
| R2 | requirement | watch mode off | boundary only, no live toggle (report-only guardrail) | not exercised live | owner | machine | Not run - would mutate shared config |
| R3 | requirement | no steers | `select action,count(*) from obs_action group by action` | zero rows with action='send' | owner | machine | PASS - 261 rows, all action='observe', zero 'send' |
| R4 | requirement | repeated-identical-tool rule | spawn hidden thread looping identical tool call | signal opens within 30s of 3rd identical call, rule=repeated-identical-tool, appears in `watch --json` and Stalls page | owner | machine+eyes | PASS - signal opened ~22s after spawn; visible live on Stalls page and composer banner |
| R5 | requirement | episode close | let looping thread finish | episode closes (closed_at set) or documented reason it does not | owner | machine | PARTIAL - thread went idle but its last signal row stayed open (closed_at NULL); no reconcile-on-finish observed. See finding F1 |
| R6 | code/heuristic | silence-no-inflight | inspect rule config/defaults | threshold = 4 min per settings | owner | machine | PASS - watch_silenceMinutes=4 |
| R7 | code/heuristic | active-no-turn | inspect rule config | threshold = 10 min | owner | machine | PASS - watch_activeNoTurnMinutes=10 |
| R8 | code/heuristic | burn-no-change | inspect rule config | threshold = 150000 tokens | owner | machine | PASS - watch_burnTokens=150000 |
| R9 | code/heuristic | retry-storm | inspect rule config | 3 in 10 min | owner | machine | PASS - watch_retryCount=3 |
| R10 | code/heuristic | tree-budget | inspect rule config | perTree 50 usd, perDay 500 usd | owner | machine | PASS - budget_perTreeUsd=50, budget_perDayUsd=500 |
| R11 | requirement | steer ladder rung 0 | observe mode active | only record-only action rows (no rung1-3 sends) | owner | machine | PASS - all 261 obs_action rows are action='observe' |
| R12 | boundary | tree-budget veto | inspect for spawn-blocking logic | tree budget never blocks a spawn | owner | machine | PASS - no veto/block-spawn code found by grep |
| R13 | requirement | inbox ranks signals | navigate to Inbox page | open signals listed, one evidence line each | owner | eyes | PASS - Inbox table lists rows with thread/status/evidence/opened/actions columns |
| R14 | requirement | inbox empty state | n/a, inbox has open signals | not exercised (non-empty state only) | owner | eyes | Not run - could not force zero-signal state without mutating store |
| R15 | requirement | nav panel | open Observatory nav panel | panel labeled "Observatory" | owner | eyes | PASS, with caveat - panel unpinned itself mid-run twice (F2) |
| R16 | requirement | inbox page | navigate | loads, lists open items | owner | eyes | PASS |
| R17 | requirement | stalls page | navigate | shows stalled threads with rule + evidence, silence timer bar as only chart | owner | eyes | PASS - live capture shows looping thread row with silence timer bar, diagnostic text, no other chart type present |
| R18 | requirement | trajectory page | navigate to a thread's trajectory tab | per-turn ledger view renders | owner | eyes | PASS, with caveat - page header text "No rule fired on this thread." contradicts the 12 rule-fired ladder-action rows shown directly below it (F3) |
| R19 | requirement | watch settings page | navigate to settings | rule enable flags + thresholds shown, match DB settings | owner | eyes | PASS - thresholds table matches DB exactly (budget 500/50, activeNoTurn 10, burn 150000, oscillation 2, repeat 3, retry 3, silence 4) |
| R20 | requirement | notification cap 6/thread/hr | inspect obs_action / notification log for a busy thread | no thread exceeds 6 in an hour | owner | machine | Not applicable in observe mode - no notifications sent (0 send rows); cap unexercised |
| R21 | requirement | notification cap 20 overall | inspect notification log | no hour exceeds 20 total | owner | machine | Not applicable, same reason as R20 |
| R22 | requirement | quiet hours | inspect setting `watch_quietHours` | value 22-07 configured | owner | machine | PASS - watch_quietHours=22-07 configured; live behavior not exercised |
| R23 | requirement | episode reopen | inspect signal history for the looping thread | new obs_signal row (new id) per re-evaluation, not reused row | owner | machine | PASS - obs_signal ids 707-713 show sequential open/close/reopen as evidence text changed |
| R24 | non-goal | module toggle off | inspect only, no live toggle | not exercised live | owner | machine | Not run - report-only guardrail forbids mutating shared config |
| R25 | adversarial | never stops a thread | grep for thread-stop/kill calls in watch module source | no such call exists | n/a | machine | PASS - `watch/ladder.ts:11` comment + grep confirm no `threads.send`/`threads.stop` call in ladder.ts; no stop/kill call found repo-wide in watch code paths |
| R26 | non-goal | tree-budget-only != STALLED | inspect signal kinds vs displayed state | a tree-budget signal alone does not set thread row status to STALLED | owner | machine | Not run - no tree-budget-only breach observed in this run's data to confirm display mapping |
| R27 | requirement | inbox counts scope | compare sidebar/inbox count to open obs_signal count | counts match total open rows across modules | owner | machine | PARTIAL - sidebar "N stalled" badge tracked watch-module opens (rose 5->6->7->8 with our probes) while DB `obs_signal` open total across all modules is ~102 (spend+watch); Inbox KPI showed "stalled 5" separately from "queued 100" (spend cache-miss rows) - scoping appears consistent (stalled = watch only, queued = spend only) rather than "all modules," see F4 |
| R28 | requirement | caps survive reload | `bb plugin install ... --yes` (reinstall/reload) then re-check settings | settings persist post-reload | owner | machine | PASS - thresholds table identical before/after reinstall |
| R29 | code | CLI `watch explain <id>` | run against the looping thread ids | prints signals + actions for that thread, no send action | owner | machine | PASS - explain output for thr_exg4i29i67 and thr_g7xkasurks show signals+actions, all action=observe |
| R30 | code | composer banner / thread row status | view looping thread's composer while stalled | shows stall indicator sourced from same signal | owner | eyes | PASS - composer banner read "stalled 1s: 7 of the last 20 items repeat commandExecution with identical input" with "open trajectory" link |
| R31 | code | sidebar accessory counts | inspect sidebar while signal open | count reflects open signal(s) | owner | eyes | PASS - sidebar badge incremented 5->6->7->8 as each probe's signal opened |
| R32 | code | agent tool observatory_trajectory | invoke tool/CLI equivalent for looping thread | returns per-turn trajectory with OSCILLATION/LOOP markers as applicable | owner | machine | Not run - tool is registered (confirmed via `bb plugin list` capabilities) and its data is structurally demonstrated by the equivalent trajectory page (R18), but the agent tool itself was not directly invoked from an agent context in this run |

Assumptions: A1 - persona is always "owner" (single-user local plugin, no
multi-tenant auth surface). A2 - rows requiring destructive mutation
(module toggle off, watch mode change) are inspected/boundary-only per the
report-only guardrail (never mutate shared config); recorded as such, not
executed live. A3 - quiet-hours live behavior not exercised (would require
waiting for/spoofing clock).
