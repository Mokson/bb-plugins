# Observatory phase 1 - QA report

**Verdict: NOT READY** at `feat/observatory` @ 5701c88. Two blockers, both on
the phase-1 exit criteria (c4 and the priced-row promise behind c2).

Rows: 24 Pass / 8 Fail / 5 Not run (TESTPLAN.md). Plugin re-installs forced by
sibling seats overwriting the install: 11.

## Blockers

### B1 - c4 split coverage is 12-23%, not the 90% the phase gate requires (R27)

`log-exact` share of Claude Code turns: **23.2% all-time (161/694)**, **11.8%
in the last 24 h (20/170)**, **22% on turns from the last 10 minutes**. Codex
is 9.1% (1/11). The gate is "over 90 percent of Claude Code and Codex turns".

Repro:
```
sqlite3 -readonly ~/.bb/plugins/observatory/data.db \
 "select t.provider_id,
         round(100.0*sum(case when u.split_source='log-exact' then 1 else 0 end)/count(*),1),
         count(*)
  from obs_turn u join obs_thread t on t.thread_id=u.thread_id
  where u.started_at > datetime('now','-1 day') group by 1;"
```
Most turns land on `log-window` (425 all-time) rather than `log-exact`, so the
join is matching a window, not the exact row.

### B2 - a freshly spawned bb thread never gets priced or split (R28)

Two threads spawned into `proj_j2jgds565d` (`thr_xmfze2t34b` "[obs-qa] cost
smoke", `thr_f4nvhjw4rq` "[obs-qa] agent tool"). Both completed. Both ingested
within 60 s, and both are still, four minutes and one forced `bb observatory
index` pass later, `split_source = unavailable` with `model_reported`,
`cost_usd`, `cost_source` and `pricing_status` all NULL.

The discriminator: turns t1-t4 of the *same provider log session* are
`log-exact` and priced; only the two new ones are not.

```
sqlite3 -readonly ~/.bb/plugins/observatory/data.db \
 "select thread_id,turn_id,split_source,cost_usd
  from obs_turn where turn_id like 'da6df8e045%' order by turn_id;"

thr_x8b9v63b57|da6df8e045-t1|log-exact|0.3905515
thr_5zfuc6ejgw|da6df8e045-t2|log-exact|0.22469075
thr_ssjwy6wmcf|da6df8e045-t3|log-exact|0.36901275
thr_xmxf7z88mt|da6df8e045-t4|log-exact|0.4114385
thr_xmfze2t34b|da6df8e045-t5|unavailable|
thr_f4nvhjw4rq|da6df8e045-t6|unavailable|
```

Reproduced independently on both threads. This is the live-path form of B1: the
newest turns are exactly the ones that fail to join, which means the 23% figure
in B1 is an optimistic ceiling, not a floor.

## High

### H1 - COST.md reports `cache_read_tokens: n/a` while `tokens_total` includes those same reads (R25, invariant 8, c3)

`bb observatory cost-md <conductor run folder> --stdout` emits:
```
tokens_total: 542591227
cache_read_tokens: n/a
cache_read_share: n/a
```
542,591,227 is the input+output+cache-read+cache-write sum (measured:
541,722,716 over `root_thread_id='thr_n5h32jdfzf'`); input+output alone is
13,282,930. So the header both suppresses cache reads as unknown and silently
counts them in the total. One null descendant nulls the whole aggregate, which
in a 47-agent run is every real run - the same `--` appears on the Lineage,
Model and Day aggregate rows in the panel. c3 says the retro seat consumes this
file without edits; the two cache keys it promises are unusable.

### H2 - `observatory_cost` returns `$0` for an unpriced model, which invariant 12 forbids (R30, R29)

The agent tool exists and answers well under the 4096-char cap. Its payload:
```json
{"scope":"thread","threadId":"thr_f4nvhjw4rq","totals":{"spendUsd":0,
"cacheSavedUsd":0,"cacheWriteUsd":0,"missCostUsd":0,"unpricedModels":1},"turns":1}
```
Invariant 12: "A missing price never becomes `$0.00`." The panel honours this
(`--`); the tool surface does not, and the consuming agent read the zeros as
real - it wrote "All costs read 0". Recommendation: emit `null` for each total
whose contributing turns are unpriced, as the panel does.

## Medium

- **M1 - filters do not round-trip through the URL, and KV beats the URL (R33).**
  Invariant 33: "query owns filters ... the URL wins on conflict." Changing the
  range select to `1d` leaves `location.search` at `?range=7d` while the view
  shows 1d totals (86.72, 17 rows); reloading that URL snaps back to 7d. In the
  other direction, loading `cost?range=7d` and clicking through to the cache
  drilldown renders the drilldown headed `range 1d` - KV won over the URL.
- **M2 - `bb observatory coverage` cannot answer c4 (R21).** It prints one
  global ratio. c4 requires the Claude Code + Codex ratio with ACP turns
  excluded and reported separately; the command has no provider segmentation,
  so the phase gate cannot be checked with the tool built for it.

## Low

- **L1 - `bb observatory status` still prints "observatory phase 0 scaffold" (R35)** with phase 1 shipped.
- **L2 - three panel nodes render at 12px (R14),** outside the 11/13/16/24 set in invariant 34. Measured sizes: `{16:1, 11:252, 12:3, 24:4, 13:1625}`.
- **L3 - `pricing_status` has a fourth, empty state** (4 turns), alongside `exact`/`logged`/`unknown`. Invariant 12 names `unpriceable` and `unknown`; no row carries `unpriceable`.

## What passed, with its oracle

- **Panel/CLI agreement is exact (R26, c16).** Same-instant capture: panel
  heroes `1,373.18 / 8,404.77 / 183.78 / 1,698.28` against
  `cost --range 7d --json` totals `1373.17673325 / 8404.77293595 /
  183.77934000000002 / 1698.27670635`. All four agree to the rendered precision.
- **Density (R10-R13, invariant 34).** Panel-scoped computed-style audit: one
  family (`Inter Variable`), max border radius 4px, all 1100 numeric cells
  right-aligned with `tabular-nums`, every `tbody` row 24px, zero emoji, and no
  colour-coded hierarchy in the row markup (`border-t border-border` hairlines).
- **Tree toggle (R2).** 231 rows / `aria-expanded=true` -> 185 / `false` -> 231
  / `true` -> 185 / `false` across four clicks.
- **Exports (R6, R7).** MD download `spend-7d-lineage-2026-09-01.md`, 24,298
  chars, correct header keys and table; JSON download
  `spend-7d-lineage-2026-09-01.json`.
- **Footer strip (R18, c5).** Renders `—% 0% $86.72` - provider limits plus a
  non-zero today's-spend chip that matches the 1d hero exactly.
- **Cache drilldown (R15, invariant 18).** Per miss: cause, prev/next turn ids,
  `cache read tok 998,895 to 272,643`, drop, `retained 27%`, `est usd 6.54`,
  and the correlate detail (`claude-opus-5 -> claude-fable-5`, `10215s idle`).
- **`cost --tree` (R23, c2)** prints priced per-turn rows with the read column.
- **Invariants 2 and 3 hold in the ledger (R31, R32).** Zero rows with
  `split_source='unavailable'` and a non-null split; only the four allowed
  `split_source` values present.

## Not run

- R16 acp-cursor no-transcript line, R17 Thread Cost tab / sparkline / spike
  click, R37 raw `bb thread log` token cross-check - dropped to the install
  churn below rather than to any product state.
- Human verification: none outstanding.

## Environmental, not product

Sibling seats re-install observatory from their own worktrees continuously;
during this run the install was overwritten within seconds of each of my own
installs (observed paths: `bb-plugins-wt/join-aliases`,
`bb-plugins-wt/watch-server`). The `watch-server` build has no spend server
module, so the panel renders "spend module not running" whenever it wins. Every
row above was executed only after re-installing from
`/Users/mokson/Projects/Personal/bb-plugins/plugins/observatory` and confirming
the path in `bb plugin list`; `journey.sh` retries the load up to eight times
for this reason. 11 re-installs total. This cost the three Not-run rows.

## Evidence

`evidence/screenshots/` - `j1-panel-landing.png`, `j1-cost-overview.png`,
`j1-tree-expanded.png`, `j1-tree-toggle.png`, `j1-group-day.png`,
`j1-range-1d.png`, `j2-cache-drilldown.png`, `j2-cache-misses.png`,
`j4-footer.png`, `j9-density.png`. Drivers: `journey.sh`, `pass2.sh`.

Threads left running and unarchived per the packet: `thr_xmfze2t34b`,
`thr_f4nvhjw4rq`.
