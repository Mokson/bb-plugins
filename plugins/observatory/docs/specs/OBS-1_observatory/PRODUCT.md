# Observatory

## Summary

Observatory is one bb plugin that reads bb thread events and on-disk provider session logs, joins them into a per-turn ledger, and serves seven read-mostly modules over it: spend, watch, context, audit, eval, distillery, plus the core that writes the ledger. Its consumers are Max at the bb UI and CLI, and the agents themselves through plugin tools and a generated `COST.md`. The plugin observes and advises; it never terminates agent work. It absorbs the existing `usage-tracker` footer strip.

## Problem

bb reports per-thread token usage but no cost, no model on the usage event, and a single `cachedInputTokens` field that fuses cache reads with cache writes. Nothing rolls cost up a thread tree, nothing detects a stalled or looping agent, and the deliver stack consumes a `COST.md` that no tool produces.

## Behavior

### Hard invariants

1. The plugin never stops, kills, cancels, or archives a thread it did not spawn. The one exception is the eval module, which may stop hidden threads it created itself when a case exceeds its cost, token, or time limit. No surface renders a kill affordance. [auto: `pnpm --filter observatory test -t "never stops a thread"`]

2. A cache read/write split is never fabricated. `cache_read_tokens` and `cache_write_tokens` are written only from a matched provider log row; with no match, both stay NULL, `split_source` is `unavailable`, and every surface renders `n/a`, never `0` and never a derived guess. [auto: `pnpm --filter observatory test -t "cache split never fabricated"`]

3. `split_source` is always one of `log-exact`, `log-window`, `sidechain`, `unavailable`. The database rejects any other value. [auto: `pnpm --filter observatory test -t "migrations-apply-idempotently"`]

4. Distillery apply never writes to or deletes a file under `~/.agents/skills`. Apply writes only `~/.agents/improvements/<date>_<slug>.md`, plus an optional `proposed` row appended to the target repo's `.agents/retro/FINDINGS.md` when that repo is on its default branch. [auto: `pnpm --filter observatory test -t "apply writes improvements not skills"`]

5. An eval baseline changes only through `bb observatory eval baseline promote <run>`. No run, gate, or cron mutates `eval_baseline`. [auto: `pnpm --filter observatory test -t "baseline moves only by promote"`]

6. `watch_mode` defaults to `observe`. In `observe` the plugin records signals and sends no message; in `off` it records nothing; only `steer` sends. A KV override set from the panel outranks the setting and applies without reload. [auto: `pnpm --filter observatory test -t "watch defaults to observe"`]

7. Every steering message has an `obs_action` row committed before the send call is issued, with `at` no later than the send timestamp. A send that fails still leaves its `obs_action` row with the failure in `result`. [auto: `pnpm --filter observatory test -t "steer recorded before sent"`]

8. A generated `COST.md` matches the retro schema shape exactly: header keys `snapshot` (`final` or `mid-run`), `generated_at`, `agents`, `cost_usd_total`, `tokens_total`, `cache_read_tokens`, `cache_read_share`; then one table with the eight columns agent, model, effort, stage, tool uses, duration s, cost usd, flags; rows sorted by cost descending; unmatched cells `n/a`. [auto: `pnpm --filter observatory test -t "COST.md shape matches retro schema"`]

9. A module that throws never stops core ingestion. After five consecutive failures the module's breaker trips, the module reports through `bb.status.needsConfiguration`, and ingestion continues. Core itself never trips. [auto: `pnpm --filter observatory test -t "module-failure-does-not-stop-core"`]

10. Ingestion is idempotent. Replaying the same event range or re-indexing the same log bytes produces the same row counts and the same values: turns key on `(thread_id, turn_id)`, items on `item_id`, log turns on `log_key`, signals on `dedupe_key`. [auto: `pnpm --filter observatory test -t "turn upsert idempotent"`]

11. Distillery text is redacted before any write: secrets, tokens, emails, public IP addresses, home paths, and tracker ids matching `[A-Z]{2,6}-\d+` or `#\d+`. Previews are capped at 1200 characters. [auto: `pnpm --filter observatory test -t "redaction"`]

12. An unpriceable or unknown model renders as `unpriceable` or `unknown` with the row still visible and its token counts intact. A missing price never becomes `$0.00`. [auto: `pnpm --filter observatory test -t "pricing status"`]

### Settings and state

13. Module toggles are bb settings named `modules_<id>_enabled` and take effect on plugin reload. A KV override under the same key outranks the setting and takes effect immediately. `watch_mode` is a select of `off`, `observe`, `steer`. [auto: `pnpm --filter observatory test -t "settings-kv-override-outranks-setting"`]

14. `bb observatory status` and the `observatory_status` RPC return the same object: module states with breaker counts and source, store counts, and non-module settings. [auto: `pnpm --filter observatory test -t "status-cli-and-rpc-agree"`]

15. `bb observatory doctor` reports the database, the applied migrations, and each provider log root. A missing provider root is a warning, not a failure exit code; only plugin storage failure exits non-zero. [auto: `bb observatory doctor`]

### Spend

16. Cost precedence is provider-logged cost, then catalog price, then `unpriceable`, then `unknown`. Cache reads and cache writes are priced separately and `cache_savings_usd` is reported.

17. When `model_requested` and `model_reported` disagree for a turn, the turn carries a `mismatch` flag and that flag appears in the `COST.md` flags column.

18. A cache-miss signal opens when a turn's `cache_read` falls below 40 percent of the prior turn's and drops by more than 20,000 tokens absolute. Its cause is the first observed correlate between the two turns in the order compaction, context-cleared, model-switch, idle-expiry, skill-injection, mcp-change, subagent-spawn, first-turn, unknown. The drilldown lists every correlate observed, not only the classified one.

19. A request fingerprint is the hash of provider, model, effort, mounted skill names, MCP server names, and instruction file hashes. A fingerprint change inside one thread opens a `prefix-changed` signal.

20. `bb observatory cost --tree <root>` prints priced rows grouped by lineage with a per-turn split, and `bb observatory cost-md <runFolder> [--snapshot]` writes the file described in (8) into the run folder. [manual: the retro seat consumes the generated file without editing it]

### Watch

21. Watch rules are silence-no-inflight (4 min), repeated-identical-tool (3 within the last 20 items), read-edit-read oscillation (2 cycles with no command between), active-no-turn (10 min), burn-no-change (150k tokens since the last file change), retry-storm (3 retrying provider errors in 10 min), and tree-budget (subtree over `budget_perTreeUsd`, default 50, or day over `budget_perDayUsd`, default 500). Each rule has its own enable flag and threshold.

22. The steer ladder is rung 0 record only, rung 1 one steer per signal with a diagnostic naming the evidence and a 10 minute per-thread cooldown, rung 2 a second steer only when a different rule fires, rung 3 escalate by steering the parent or root thread, publishing on the `observatory/escalation` realtime channel, and setting the thread row status. Rung 3 never escalates past the root.

23. Tree budget cannot veto a spawn. On breach it steers the parent thread with the subtree bill.

24. The post-compaction premise reminder is off by default. When on, a compaction in a thread with a resolved run folder sends exactly one queued message listing the ledger `## Done-when` section rows and the open decision rows.

25. The attention inbox ranks open signals across modules with one evidence line each and is the panel's landing page. An empty inbox renders an explicit empty state, not a blank page.

### Context

26. The context scan covers project and global instruction files with their imports, the skills catalog frontmatter, the MCP configuration, and this plugin's own tools. It reports duplicates by shingle hash with recoverable tokens, dead skills (mounted descriptions never matched by a Skill item in any indexed session) with bytes saved, and a compaction estimate.

27. Token estimates are calibrated per provider against the first turn's `cache_write`, which is the ground-truth prefix size. Estimated numbers render with a superscript `e` and a footnote; unknown numbers render `--`.

### Audit and eval

28. `observatory_audit_pack({threadId | runFolder})` returns session metrics against the 7-day median, verification-command detection, unverified edits, the failure ledger, and insight facets, and writes `audit.json`, `audit.md`, and `COST.md` into the run folder.

29. An eval case is a YAML file with structured assertion keys. There is no expression language. An unknown key fails the case.

30. An interaction with no matching answer rule fails the case as `unanswered-gate`. Reaching the case cost ceiling stops the case as `fail:budget` with partial artifacts harvested.

31. Gate verdicts: a structural assertion failure or a pass-to-fail transition is FAIL; tokens up over 50 percent, cost over 40 percent, wall over 60 percent, or a newly flaky case is WARN; no baseline is N/A and exits 2.

32. The judge runs only after every structural assertion passes, and is advisory unless calibration reaches TPR and TNR of at least 0.9.

### Surfaces

33. The panel is one nav panel "Observatory" whose path owns identity and query owns filters; filters persist in KV and the URL wins on conflict. Routes: inbox, cost, cost cache drilldown, stalls, per-thread tabs (cost, context, trajectory), context, audit sessions, audit failures, audit insights, eval cases, eval runs, distillery, settings.

34. Density: one font at sizes 11, 13, 16, and 24 for at most four linked hero numbers per page; weights 400 and 600; 24px rows; hairlines not boxes; radii at most 4px; numerics right-aligned with tabular figures and the unit in the header; no emojis; no color-coded hierarchy. Exactly three charts exist: cost-by-turn sparkline, silence timer bar, context composition bar. Everything else is a table with Markdown and JSON export. [manual: rendered screenshot of each route]

35. Message directives `::observatory-cost`, `::observatory-context`, `::observatory-audit`, `::observatory-eval` render compact cards. A bad attribute renders one explanatory line, never a blank card.

36. Notifications are capped at 6 per thread per hour and 20 overall, respect quiet hours, and are silent for the thread currently being viewed. Stalled fires once per episode and re-arms on a new item; over-budget fires once per threshold crossing and re-arms on doubling; a new failure signature fires on its second occurrence.

## Acceptance criteria

Each criterion is a phase done-check.

- c1: Deliver-stack edits land, the fixture repo exists as a registered bb project, and the plugin scaffold's tests pass green against the fake host. (phase 0)
- c2: `bb observatory cost --tree <root>` prints priced rows with a cache split for a Claude Code run. (phase 1)
- c3: `bb observatory cost-md <runFolder>` writes a file the retro seat consumes without edits. (phase 1)
- c4: On a fresh deliver run inside bb, over 90 percent of Claude Code and Codex turns carry a `log-exact` split source; ACP turns are excluded from the ratio and reported separately. (phase 1)
- c5: The absorbed footer strip shows provider limits plus today's spend. (phase 1)
- c6: A deliberately looping thread appears in the stall list within 30 seconds attributed to the correct rule. (phase 2)
- c7: Phase 2 sends zero steers; `obs_action` holds no send rows. (phase 2)
- c8: Every steer has an `obs_action` row whose timestamp precedes its send. (phase 3)
- c9: No thread is ever stopped by the plugin, verified across the phase 3 rule set. (phase 3)
- c10: `observatory_audit_pack` returns the metrics the harness-audit skill reads. (phase 4)
- c11: First-turn token calibration error is under 15 percent. (phase 4)
- c12: `bb observatory eval run --tag smoke --gate` exits 0 on the current stack. (phase 5)
- c13: The same command exits 1 when a seeded regression patch is applied to the stack. (phase 5)
- c14: A seeded ledger with three nudges of one cause-class yields exactly one draft in the queue. (phase 6)
- c15: Distillery apply writes only under `~/.agents/improvements/` and leaves the skill tree hash unchanged. (phase 6)
- c16: Totals from `bb observatory cost --run <folder>` agree within 2 percent with the ledger runlog token sums for the same run. (integration)

## Out of scope

- Stopping, cancelling, or rate-limiting any thread.
- Editing skill files, or any write outside `~/.agents/improvements/` and the run folder.
- A plugin-to-plugin service API. bb has none, which is why this is one plugin rather than a family.
- Byte-level prefix diffing for cache-miss root cause. Provider logs carry neither the system prompt nor tool schemas.
- A `push-notify` consumer. The realtime channel is published; the consumer is a follow-on.
- `experimental_threadList` and `experimental_threadHeaderAction`, both owned by `better-sidebar`.
- Card, badge, alert, progress, avatar, accordion, and chart shadcn components.
- The follow-on plugin backlog: tool-surface folding, micro-clear compaction, skill catalog folding, code review loop, verification receipts, scoped approvals.

## Design source

The plan's ASCII layouts for the inbox, cost overview, and stall monitor are the layout source. No visual design file exists; density rules in (34) are the contract.

## Success metrics

- Split coverage: share of Claude Code and Codex turns with `log-exact` on runs inside bb, target over 90 percent - evaluate at the end of phase 1.
- Rung-1 steer precision measured on phase 2 observe-only data - evaluate before enabling phase 3.
- Cost agreement against ledger runlog sums within 2 percent - evaluate at integration.
- Distillery draft acceptance rate - evaluate one month after phase 6.
