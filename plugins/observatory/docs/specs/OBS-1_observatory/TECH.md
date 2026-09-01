# Observatory - TECH

Behavior contract: `PRODUCT.md` in this folder. This document does not restate behavior.

## Context

Repository `Mokson/bb-plugins`, branch `feat/observatory`, plugin root `plugins/observatory`. Phase 0 is committed (`observatory: phase 0 scaffold`): `package.json` declares `bb.server`, `bb.app`, `bb.host`, icon `Eye`, `engines.bbPluginSdk >= 0.4.21`. Present today: `src/server.ts`, `src/contract.ts`, `src/module.ts`, `src/host.ts`, `src/core/{store,migrations,host-client}.ts`, `src/app/{app.tsx,pages/*,components/ui/*}`, and seven tests under `test/`.

Platform constraints the design rests on:

1. `thread/tokenUsage/updated` gives `{inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens}`. The claude-code and pi bridges both set `cachedInputTokens = cache_read + cache_creation`. No cost field, no model.
2. `bb.events.on` carries thread lifecycle only. Turn, item, and usage rows come from `bb.sdk.threads.events.list` and `events.wait`; the push signal is `bb.sdk.subscribe({event:"thread:changed"})` filtered on `metadata.eventTypes`.
3. No API exposes provider session log paths. The join is `providerThreadId` from `thread/identity` plus a timestamp window.
4. Claude Code and Codex logs carry neither the system prompt nor tool schemas, so cache-miss cause is correlate-based.
5. bb has no plugin-to-plugin RPC or service API. One plugin, seven modules.
6. `@bb/shared-ui` is private; shadcn components are vendored under `src/app/components/ui`.
7. Deliver seats are bb child threads only when deliver runs inside bb; otherwise they appear as `isSidechain` rows in Claude Code logs. Both are handled.

## Proposed changes

### Module boundaries and owned paths

| Module | Owned path | Writes | Reads |
| --- | --- | --- | --- |
| core | `src/core/` | every `obs_*` table, `pricing_catalog` | bb events, host log rows |
| spend | `src/spend/` | `obs_signal` (spend), run-folder `COST.md` | `obs_turn`, `obs_match`, `obs_log_turn`, catalog |
| watch | `src/watch/` | `obs_signal` (watch), `obs_action` | `obs_turn`, `obs_item`, spend rollups |
| context | `src/context/` | `obs_ctx_snapshot`, `obs_ctx_block` | filesystem surfaces, `obs_log_turn` |
| audit | `src/audit/` | run-folder `audit.json`, `audit.md`, `COST.md` | all core tables, spend rollups |
| eval | `src/eval/` | `eval_run`, `eval_case_result`, `eval_baseline` | its own worktrees and hidden threads |
| distillery | `src/distillery/` | `corrections`, `correction_clusters`, `drafts`, `~/.agents/improvements/` | ledger prose, findings register, signals |

Core is the only writer of the shared ledger. Every other module is a read-mostly analyzer that owns exactly its own tables and artifacts. Modules never import each other's internals; cross-module data flows through the ledger tables and the interfaces below.

Each module is registered through `defineModule({id, setup})` (`src/module.ts`). `ModuleRegistry` hands each a `ModuleContext` with `job()`, `enabled()`, `db()`, `breaker()`. `job()` swallows and counts failures; `BREAKER_LIMIT` is 5 consecutive failures; core is exempt from tripping.

### Data model

The phase 0 schema is already applied by `src/core/migrations.ts` as an ordered, append-only statement list keyed by index through `bb.storage.migrate`. Schema changes append; shipped statements are never edited or reordered.

```sql
obs_thread(thread_id PK, project_id, provider_id, provider_thread_id, parent_thread_id,
  root_thread_id, depth, title, seat, tier_tag, visibility, origin, run_folder, cwd,
  created_at, last_event_seq, last_seen_at, status)
obs_turn(thread_id, turn_id, root_thread_id, seq_started, seq_completed, started_at,
  completed_at, duration_ms, model_requested, model_reported, effort,
  input_tokens, cached_input_tokens, cache_read_tokens NULL, cache_write_tokens NULL,
  output_tokens, reasoning_tokens, context_used, context_window,
  cost_usd, cost_source, pricing_status, cache_savings_usd,
  tool_calls, file_changes, file_reads, compacted, error_category, will_retry,
  split_source CHECK IN ('log-exact','log-window','sidechain','unavailable'), PK(thread_id, turn_id))
obs_item(item_id PK, thread_id, turn_id, seq, kind, name, status, started_at, completed_at,
  duration_ms, path, input_fingerprint, error)
obs_log_file(path PK, root_id, provider, size_bytes, mtime_ms, indexed_bytes, indexed_lines,
  parser_version, content_hash, provider_thread_id, indexed_at, parse_error)
obs_log_turn(log_key PK, provider, provider_thread_id, ts, model, input, cache_read,
  cache_write, output, reasoning, logged_cost_usd, is_sidechain, agent_id, cwd,
  skill_names, mcp_names)
obs_match(thread_id, turn_id, log_key, method, confidence, PK(thread_id, turn_id))
obs_signal(id PK, module, kind, thread_id, turn_id, severity, opened_at, closed_at,
  payload JSON, dedupe_key UNIQUE)
obs_action(id PK, signal_id, thread_id, action, at, detail, result)
pricing_catalog(id, revision, fetched_at, data)
obs_root(id PK, provider, path, kind, exists_flag, last_scan_at, error)
obs_meta(key PK, value)
```

Later migrations append `obs_ctx_snapshot`, `obs_ctx_block` (phase 4), `eval_run`, `eval_case_result`, `eval_baseline` (phase 5), `corrections`, `correction_clusters`, `drafts` (phase 6).

Join rule: candidates by `(provider, provider_thread_id)`, then greedy monotone match on `ts` within `[started_at - 2s, completed_at + 10s]`. Method `log-exact` when `cache_read + cache_write == cachedInputTokens` and `output == outputTokens`; `log-window` when only the window matches unambiguously; `sidechain` when the log row is a subagent row attached to the parent turn as a synthetic child with `seat` from the subagent tag; otherwise `unavailable` and both split columns stay NULL.

Model resolution: `model_reported` from the log row, `model_requested` from the newest `client/turn/requested.data.execution.model`. Disagreement sets the `COST.md` `mismatch` flag.

Cost precedence: `logged_cost_usd`, then catalog price, then `unpriceable`, then `unknown`.

Idempotency: `obs_thread.last_event_seq` is the event watermark; upserts key on `(thread_id, turn_id)`, `item_id`, `log_key = provider:session:ts:line`, and `obs_signal.dedupe_key`. Retention: items 30 days, log turns 90 days, turns 365 days, signals and actions kept forever (they are the evidence a steer happened).

Seat and tier: `[model:effort] title` thread titles parse into `seat` and `tier_tag`, cross-checked against ledger runlog rows when `cwd` resolves a `docs/specs/<id>_<slug>/` run folder.

### Pinned inter-module interfaces

These signatures are the seams other modules code against. Changing one is a spec edit.

```ts
// src/core/store.ts (exists)
class ObservatoryStore {
  constructor(db: Database);
  upsertThread(row: Partial<Nullable<ThreadRow>> & { thread_id: string }): void;
  upsertTurn(row: Partial<Nullable<TurnRow>> & { thread_id: string; turn_id: string }): void;
  upsertItem(row: Partial<Nullable<ItemRow>> & { item_id: string; thread_id: string }): void;
  openSignal(signal: OpenSignal): number;   // returns the EXISTING id on dedupe
  closeSignal(id: number, closedAt: string): void;
  recordAction(action: RecordAction): number;
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  counts(): StoreCounts;
  prune(retention: { itemsDays: number; logTurnsDays: number; turnsDays: number }): void;
}

// src/core/log-store.ts (phase 1)
interface LogStore {
  upsertLogFile(row: LogFileRow): void;
  upsertLogTurn(row: LogTurnRow): void;
  cursors(roots: readonly string[]): Record<string, number>;
  candidates(provider: string, providerThreadId: string): LogTurnRow[];
  recordMatch(threadId: string, turnId: string, logKey: string,
              method: SplitSource, confidence: number): void;
}

// src/core/pricing.ts (phase 1)
function loadCatalog(db: Database, opts?: { maxAgeHours?: number }): Promise<PricingCatalog>;
function priceTurn(turn: TurnRow, catalog: PricingCatalog): {
  costUsd: number | null;
  costSource: "logged" | "catalog" | "unpriceable" | "unknown";
  pricingStatus: "exact" | "alias" | "logged" | "unpriceable" | "unknown";
  cacheSavingsUsd: number | null;
};

// src/core/indexer.ts (phase 1)
function createLogIndexer(deps: {
  host: HostClient;
  logStore: LogStore;
  roots(): Promise<string[]>;
  limit?: number;
}): { runOnce(): Promise<{ rows: number; done: boolean }> };

// src/core/ingest.ts (phase 1)
function createIngest(deps: {
  bb: BbPluginApi;
  store: ObservatoryStore;
  logStore: LogStore;
  catalog(): Promise<PricingCatalog>;
}): {
  markDirty(threadId: string): void;
  drain(): Promise<{ threads: number; turns: number }>;
  reconcileStale(): Promise<number>;
};

// src/core/host-client.ts (exists)
interface HostClient {
  ping(): Promise<{ ok: true }>;
  indexBatch(input: IndexBatchInput): Promise<IndexBatchOutput>;
}
```

`LocalHostClient` implements `HostClient` in-process for phase 1 and every test; the `bb.host` entry (`src/host.ts`) answers the same `hostContract`, so moving parsing to the daemon swaps one object.

### Data flow and jobs

```
bb.sdk.subscribe(thread:changed) --> dirty set --> ingest.drain()
                                                     |
provider log files --> host.indexBatch --> LogStore --+--> join --> obs_turn
                                                     |
pricing catalog ---------------------------------- priceTurn
                                                     |
                                     obs_turn --> spend | watch | context | audit
```

| Job | Carrier | Cadence | Owner |
| --- | --- | --- | --- |
| drain dirty set | `bb.background.service("ingest")` | continuous, `events.list({afterSeq})` | core |
| long-poll active thread | `events.wait` per active thread | while active | watch |
| stale-thread reconcile | cron | `*/1` | core |
| log indexer | cron | `*/5` | core |
| pricing refresh | cron | daily, `pricing_refreshHours` | core |
| watch rule scan | cron | `*/1` | watch |
| context scan | cron | daily plus on demand | context |
| eval smoke suite | cron | nightly, skipped when neither the stack repo nor the cases changed | eval |
| retention prune | cron | daily | core |

`bb observatory backfill --since <date>` re-runs the indexer and join over a date range and reports coverage as the share of turns with `log-exact`.

### Reuse map

Copy, do not rewrite. Sources are read-only references outside this repo.

| Target | Source |
| --- | --- |
| pricing and catalog | `MayankBansal12_bb-plugin-usage/lib/{pricing,catalog}.ts`; `UNPRICEABLE_MODELS` and provider-reported precedence from `iamEvanYT_bb-usage-page/lib/pricing.ts`; longest-prefix matching from `bb-plugin-conductor/src/spend-pricing.ts` for ids like `claude-opus-5[1m]` |
| log parsers | `MayankBansal12_bb-plugin-usage/collectors.ts` (Claude, Codex, Pi); `xMinor-1_bb-plugins/plugins/usage-meter/usage-scan.ts` for `isSidechain` plus skill and MCP attribution; `braedonsaunders_bb-plugin-provider-usage/lib/{cursor-scan,opencode-scan}.ts` |
| indexer and host layout | `patleeman_bb-plugins/packages/bb-plugin-traces/src/{indexer,host}.ts` (byte-offset resume, truncation, prune) |
| event fallback, total guards | `braedonsaunders/lib/bb-usage-scan.ts` |
| live number plumbing | `Hazihell_bb-plugin-context-meter/server.ts` |
| thread tree, hidden-thread `operationId` | `bb-plugin-conductor/src/server.ts` (BFS replaced by `root_thread_id`, tree row limit kept) |
| failure taxonomy, no-progress fingerprint | `KaviiSuri_bb-plugin-goal/src/{failure,progress}.ts` |
| stale detection paging | `yegor-korobeynikov_bb-plugin-stale-resume/detect.ts` |
| finding lifecycle tables | `salemsayed_bb-plugin-advisor/server.ts` |
| footer strip, `newestEvent` | `bb-plugins/plugins/usage-tracker/lib/{sidebar-strip,load-usage}.ts` absorbed as is plus today's spend; `bb-plugins/plugins/better-sidebar/src/server.ts` |

### Target file layout

```
plugins/observatory/
  package.json
  src/server.ts            module registry, settings, CLI root, RPC root
  src/contract.ts          rpc contract, observatory_status
  src/host.ts              log indexer worker entry
  src/module.ts            defineModule, ModuleRegistry, breaker
  src/core/{store,migrations,host-client}.ts                       (exist)
  src/core/{events,ingest,join,indexer,log-store,pricing}.ts        (phase 1)
  src/core/parsers/{claude,codex,pi,cursor,opencode}.ts             (phase 1)
  src/spend/{rollup,cache-miss,fingerprint,cost-md}.ts
  src/watch/{rules,ladder,budget,inbox}.ts
  src/context/{scan,estimate,duplicates}.ts
  src/audit/{pack,failures,insights}.ts
  src/eval/{cases,runner,harvest,assert,gate,baseline}.ts
  src/distillery/{signals,redact,cluster,draft,queue,apply}.ts
  src/app/app.tsx          navPanel, tabs, banner, strip, directives, renderers
  src/app/pages/*.tsx      one file per route
  src/app/components/ui/   vendored shadcn subset
  test/*.test.ts           one invariant per file
  test/fakes.ts, test/fixtures/logs/<provider>/*
  docs/specs/OBS-1_observatory/{PRODUCT.md,TECH.md}
```

Vendored shadcn subset: button, input, label, checkbox, switch, select, tabs, table, separator, scroll-area, tooltip, popover, dropdown-menu, dialog, command, skeleton, collapsible, toggle-group.

### Settings

Setting keys use underscores; bb rejects dots. Module toggles are `modules_<id>_enabled` (reload required). A KV value under the same key outranks the setting and applies immediately. `watch_mode` is a select of `off`, `observe`, `steer`, default `observe`. Numeric thresholds live in KV, edited from the panel settings page. The remaining descriptors already declared: `roots_extra`, `pricing_refreshHours`, `retention_itemsDays`, `retention_logTurnsDays`, `retention_turnsDays`, `budget_perTreeUsd`, `budget_perDayUsd`, `eval_casesDir`, `eval_fixturesDir`, `distillery_improvementsDir`, `distillery_monthlyBudgetUsd`, `agents_optInProjects`.

### Agent-facing surface

Tools: `observatory_cost`, `observatory_context`, `observatory_trajectory`, `observatory_failures`, `observatory_audit_pack`, `observatory_distill`, `distillery_status`. `distillery_status` keeps its name because the gc skill references it. Instructions are injected through `bb.agents.configure` only for threads whose title carries a deliver seat tag or whose project appears in `agents_optInProjects`, capped near 500 characters. `experimental_timelineRenderer` renders this plugin's own tool results and `observatory/eval-case` extension items as tables.

### SDK gaps

The design works around each of these; all are filed upstream as bb asks.

1. No separate `cacheReadTokens` and `cacheWriteTokens` on `thread/tokenUsage/updated`. Worked around by the log join; unmatched turns render `n/a`.
2. No `costUsd` or `costSource` on the usage event. Worked around by the pricing catalog and log-reported cost.
3. No `model` on the usage event. Worked around via `client/turn/requested`.
4. No provider session log path on the thread. Worked around by scanning known roots and joining on `providerThreadId`.
5. No opt-in turn, item, or usage events on `bb.events.on`. Worked around by `thread:changed` plus `events.list({afterSeq})`.
6. No channel-scoped `realtime` subscription. Escalation publishes a single `observatory/escalation` channel.
7. No hot settings reload. Worked around by the KV override layer.
8. No plugin service registry. This is why the seven modules ship as one plugin.
9. No spawn veto hook. Tree budget steers the parent instead of blocking.

## Testing and validation

Unit tests are one invariant per file under `test/`, named for the invariant. Mapping from `PRODUCT.md`:

| Invariant | Test or command |
| --- | --- |
| 1 steer never stops | `test/steer-never-stops-a-thread.test.ts` plus a grep gate asserting no stop or cancel call site |
| 2, 3 split never fabricated | `test/cache-split-never-fabricated.test.ts`, `test/migrations-apply-idempotently.test.ts` |
| 4 apply writes improvements | `test/apply-writes-improvements-not-skills.test.ts` |
| 5 baseline promote only | `test/baseline-moves-only-by-promote.test.ts` |
| 6 watch default observe | `test/watch-defaults-to-observe.test.ts` |
| 7 steer recorded first | `test/steer-recorded-before-sent.test.ts` |
| 8 COST.md shape | `test/cost-md-shape-matches-retro-schema.test.ts` |
| 9 breaker isolation | `test/module-failure-does-not-stop-core.test.ts` |
| 10 idempotency | `test/turn-upsert-idempotent.test.ts`, `test/signal-dedupe-key-returns-existing.test.ts` |
| 11 redaction | `test/distillery-redacts-before-write.test.ts` |
| 12 pricing status | `test/pricing-status-never-zero.test.ts` |
| 13 settings precedence | `test/settings-kv-override-outranks-setting.test.ts` |
| 14 status parity | `test/status-cli-and-rpc-agree.test.ts` |
| 29, 30 eval assertions | `test/unanswered-gate-fails-case.test.ts`, `test/unknown-assert-key-fails.test.ts` |
| 34, 35 surfaces | `test/panel-renders-placeholders.test.tsx` plus manual render evidence |

Commands: `pnpm --filter observatory test`, `pnpm --filter observatory typecheck`, `pnpm --filter observatory run types:check`, and `experimental_scanPublicSdkOnly` in CI.

Integration: install into the local bb with `bb plugin install git:... --subdirectory plugins/observatory`, run one deliver bug route inside bb against the fixture repo, then compare `bb observatory cost --run <folder>` against the ledger runlog token sums and against an independent usage plugin's totals for the same day; agreement within 2 percent (criterion c16).

Manual evidence: render every panel route and every thread tab in a browser and capture screenshots before publishing, checking one font, right-aligned numerics, no color-coded hierarchy, no kill affordance (invariants 1, 34).

Eval: the phase 5 done-check is itself the regression gate for the deliver skill stack.

## Rollout

Phase 0 is landed. Each later phase ships something usable alone.

| Phase | Scope | Done check |
| --- | --- | --- |
| 0 | Deliver-stack edits, fixture repo, scaffold with `defineModule`, store, fake-host tests | c1 |
| 1 | core plus spend read-only, `COST.md`, absorbed footer strip | c2, c3, c4, c5 |
| 2 | watch in `observe`, signals, inbox page, thread row status | c6, c7 |
| 3 | steer ladder, escalation, tree budget, gated on phase 2 precision data | c8, c9 |
| 4 | context composition, audit pack, exports | c10, c11 |
| 5 | eval with five smoke cases and baselines | c12, c13 |
| 6 | distillery | c14, c15 |

Phase 0 prerequisites outside this repo: `deliver/references/tracker.md` gains an explicit `tracker:none` token; `deliver/references/ledger.md` header template gains `stack:` and `tracker:` and settles on one done-when anchor; `deliver/scripts/check-ledger.sh` gains `--json` emitting `{rows, fails, warns, findings[]}`; `deliver/scripts/verify-stack.sh` accepts a `DELIVER_BUNDLE_DIR` override; `~/fixtures/deliver-fixture` is created and registered as a bb project with a seeded bug branch and patches.

Marketplace: add an `observatory` entry to `marketplace.json` with `tagPrefix: observatory/`; retire the `usage-tracker` entry once the strip ships in phase 1.

## Parallelization

Phases 1 through 6 are sequential on the ledger: every analyzer reads what core writes. Within a phase, module directories are disjoint and safe to split across subagents by owned path from the table above. Two seams are shared and must be owned by one seat per phase: `src/core/migrations.ts` (append-only, serialize appends) and `src/server.ts` (module registration and CLI command list). Merge strategy: module directories merge independently; the two shared files are edited last, by the integrating seat.

## Risks and mitigations

- Log format drift breaks a parser silently. Mitigation: `parser_version` and `parse_error` on `obs_log_file`, plus fixture logs per provider under `test/fixtures/logs/`.
- Join ambiguity inflates `log-window` matches and misattributes cost. Mitigation: `obs_match.confidence`, coverage reported by `backfill`, and `unavailable` preferred over a guess.
- Rung-1 steers could interrupt healthy work. Mitigation: phase 3 is gated on rung-1 precision measured from phase 2 observe-only data; cooldowns and the notification cap bound the blast radius.
- Eval worktrees and hidden threads leak on failure. Mitigation: harvest then remove unless `keep_on_fail`; `operationId` in the hidden-thread title gives exactly-once spawning.
- Distillery could exfiltrate secrets into an improvements file. Mitigation: redaction runs before any write, previews capped, per-rule redaction counts stored, and homes allowlisted under `~/.agents`.
- SQLite growth from `obs_item` on long runs. Mitigation: the retention prune job and the per-table day settings.
- Module breaker masks a persistent bug as a quiet "off". Mitigation: tripping reports through `bb.status.needsConfiguration` and shows in `bb observatory status`.

## Follow-ups

- `push-notify` consumer for the `observatory/escalation` realtime channel, once the channel contract is agreed.
- The eight upstream bb asks in the SDK gaps section, filed as issues.
- The separate-plugin backlog fenced in `PRODUCT.md`.
