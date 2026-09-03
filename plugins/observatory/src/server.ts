// Observatory — backend entry.
//
// Phase 0 assembles the skeleton and nothing else: settings, the migrated
// store, the module registry with its per-module breaker, one status view
// served identically to the CLI and the panel, and a doctor that checks the
// provider log roots exist. Every module's `setup` is a stub; the modules
// themselves land in later phases behind these seams.
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Database } from "better-sqlite3";
import type {
  BbPluginApi,
  PluginSettingDescriptor,
  PluginSettingDescriptors,
} from "@get-bb/plugin-sdk";
import { observatoryContract, type ModuleState, type StatusView } from "./contract.js";
import { ObservatoryStore, applyMigrations } from "./core/store.js";
import {
  EventStore,
  type CoverageView,
  type ProviderCoverageView,
} from "./core/store-events.js";
import { createIngest, type Ingest, type IngestCounters } from "./core/ingest.js";
import type { LogTurnSource, PriceTurnFn } from "./core/join.js";
import { LocalHostClient } from "./core/host-client.js";
import { LogStore } from "./core/store-logs.js";
import { priceTurnPort } from "./core/pricing.js";
import { loadCatalog, type PricingCatalog } from "./core/catalog.js";
import {
  createLogIndexer,
  defaultLogRoots,
  type LogIndexer,
} from "./core/indexer.js";
import {
  spendContract,
  type CacheMissRow,
  type SpendGroup,
  type SpendRange,
  type SpendRow,
  type SpendThreadView,
} from "./spend/contract.js";
import {
  agentTotals,
  formatOverview,
  SPEND_ROW_LIMIT,
  spendExport,
  spendOverview,
  spendThread,
  spendToday,
  type OverviewQuery,
  type RollupDeps,
} from "./spend/rollup.js";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  detectCacheMisses,
} from "./spend/cache-miss.js";
import { scanFingerprints } from "./spend/fingerprint.js";
import { buildCostMd, type Snapshot } from "./spend/cost-md.js";
import {
  COMPACT_LIMIT_OPTIONS,
  loadUsageSnapshot,
  usagePreferences,
} from "./spend/usage.js";
import { contextContract } from "./context/contract.js";
import type { PluginToolDescriptor } from "./context/scan.js";
import {
  contextThread,
  formatContext,
  formatSurfaces,
  formatThreadContext,
  takeSnapshot,
  type ContextDeps,
} from "./context/snapshot.js";
import { auditContract } from "./audit/contract.js";
import {
  assertInside,
  auditExport,
  auditSession,
  auditSessions,
  auditPackWithExport,
  formatSession,
  formatSessions,
  writeAuditPack,
  type AuditDeps,
  type AuditTarget,
} from "./audit/pack.js";
import {
  failureRows,
  formatFailures,
  muteFailure,
} from "./audit/failures.js";
import { auditInsights, formatInsights } from "./audit/insights.js";
// --- eval ---
import { evalContract } from "./eval/contract.js";
import { EvalStore } from "./eval/store.js";
import { EVAL_CLI_COMMANDS, EVAL_COMMAND, runEvalCommand } from "./eval/cli.js";
import type { EvalLiveDeps } from "./eval/deps.js";
import { stackSha } from "./eval/dryrun.js";
import {
  NIGHTLY_KV_KEY,
  hashCasesDir,
  shouldRunNightly,
  type NightlyFingerprint,
} from "./eval/nightly.js";
import {
  baselineView,
  casesView,
  loadCases,
  runView,
  runsView,
  type EvalDeps,
} from "./eval/views.js";
// --- end eval ---
import {
  CORE_MODULE_ID,
  ModuleRegistry,
  defineModule,
  isEnabledSetting,
  moduleEnabledKvKey,
  moduleEnabledSettingKey,
  type ModuleContext,
  type ModuleId,
  type ObservatoryModule,
} from "./module.js";
import {
  WATCH_CLI_COMMANDS,
  WATCH_SETTING_DESCRIPTORS,
  createTrajectory,
  createWatchModule,
  createWatchRpcHandlers,
  runWatchCli,
  watchContract,
  type WatchHandle,
} from "./watch/index.js";
import {
  DISTILLERY_SETTING_DESCRIPTORS,
  DISTILL_CLI_COMMANDS,
  STATUS_TOOL as DISTILL_STATUS_TOOL,
  createDistilleryModule,
  createDistilleryRpcHandlers,
  distilleryContract,
  renderStatusTool,
  runDistillCli,
  type DistilleryHandle,
} from "./distillery/index.js";

/**
 * Kept in step with package.json; the bundle cannot import that at runtime.
 *
 * A test asserts the two agree, so a release that bumps one and forgets the
 * other fails in CI rather than in a support round.
 */
export const VERSION = "0.0.3";

/**
 * Where this build is actually installed.
 *
 * "which observatory am I talking to" is the first question of every support
 * round, and with several worktrees installing over each other it is not
 * answerable from the outside. `src/server.ts` sits one level under the
 * plugin root, and the bundle keeps that shape.
 */
export function installedPath(): string {
  try {
    return fileURLToPath(new URL("..", import.meta.url));
  } catch {
    return "unknown";
  }
}

/** Registration order is ingest-first: everything else reads what core wrote. */
export const MODULE_IDS: readonly ModuleId[] = [
  "core",
  "spend",
  "watch",
  "context",
  "audit",
  "eval",
  "distillery",
];

/** Where each provider keeps its session logs, checked by `doctor`. */
export const DEFAULT_LOG_ROOTS: ReadonlyArray<{
  provider: string;
  path: string;
}> = [
  { provider: "claude-code", path: "~/.claude/projects" },
  { provider: "codex", path: "~/.codex/sessions" },
  { provider: "pi", path: "~/.pi/agent/sessions" },
  { provider: "acp-cursor", path: "~/.cursor/acp-sessions" },
  { provider: "acp-omp", path: "~/.omp/agent/sessions" },
];

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * Log bytes one scheduled pass may parse, in megabytes.
 *
 * Measured rather than guessed. On a machine holding 2,685 session files and
 * 2.5GB of logs, a COLD pass over all eight roots costs 305ms at this budget
 * and 318ms at twice it: the pass stops on the row cap long before it stops on
 * bytes, and a warm pass costs only the walk. The old 5MB meant a cold start
 * needed hundreds of five-minute ticks, close to two days, to reach steady
 * state, and in practice never got past the first root at all.
 *
 * The ceiling that actually bounds a pass is `MAX_ROWS_PER_PASS`. This one
 * exists so a single enormous log cannot monopolise a pass.
 */
const DEFAULT_INDEX_BUDGET_MB = 256;

function moduleToggle(id: ModuleId): PluginSettingDescriptor {
  return {
    type: "boolean",
    label: `Module: ${id}`,
    description: `Run the ${id} module. Takes effect on \`bb plugin reload observatory\`.`,
    default: true,
  };
}

export const SETTING_DESCRIPTORS = {
  ...Object.fromEntries(
    MODULE_IDS.map((id) => [moduleEnabledSettingKey(id), moduleToggle(id)]),
  ),
  // Watch owns its rule toggles, thresholds and quiet hours; `watch_mode` and
  // the two budget keys stay declared below because other modules read them.
  ...WATCH_SETTING_DESCRIPTORS,
  // Distillery owns its provider pin, effort and findings-append flag;
  // `distillery_improvementsDir` and `distillery_monthlyBudgetUsd` stay
  // declared below because phase 0 shipped them.
  ...DISTILLERY_SETTING_DESCRIPTORS,
  "watch_mode": {
    type: "select",
    label: "Watch mode",
    description:
      "off records nothing, observe records signals only, steer also sends steering messages.",
    options: ["off", "observe", "steer"],
    default: "observe",
  },
  "roots_extra": {
    type: "string",
    label: "Extra log roots",
    description: "Comma-separated absolute paths scanned beside the defaults.",
    default: "",
  },
  "pricing_refreshHours": {
    type: "string",
    label: "Pricing refresh (hours)",
    default: "24",
  },
  "index_budgetMb": {
    type: "string",
    label: "Log indexer: bytes read per pass (MB)",
    description:
      "Upper bound on log bytes parsed in one five-minute pass. Unchanged files cost nothing, so this is only spent on new content.",
    default: String(DEFAULT_INDEX_BUDGET_MB),
  },
  "retention_itemsDays": {
    type: "string",
    label: "Retention: items (days)",
    default: "30",
  },
  "retention_logTurnsDays": {
    type: "string",
    label: "Retention: log turns (days)",
    default: "90",
  },
  "retention_turnsDays": {
    type: "string",
    label: "Retention: turns (days)",
    default: "365",
  },
  "spend_cacheTtlMinutes": {
    type: "string",
    label: "Provider prompt-cache TTL (minutes)",
    description:
      "An idle gap longer than this expires the cached prefix, which is how a cache miss is classified idle-expiry.",
    default: String(DEFAULT_CACHE_TTL_MINUTES),
  },
  "usage_enableClaudeCode": {
    type: "boolean",
    label: "Footer strip: Claude Code",
    description: "Show Claude Code usage in the sidebar footer.",
    default: true,
  },
  "usage_enableCodex": {
    type: "boolean",
    label: "Footer strip: Codex",
    description: "Show Codex usage in the sidebar footer.",
    default: true,
  },
  "usage_compactLimit": {
    type: "select",
    label: "Footer strip: compact limit",
    description: "Which limit the compact percentage and bar show.",
    options: [...COMPACT_LIMIT_OPTIONS],
    default: "Weekly",
  },
  "budget_perTreeUsd": {
    type: "string",
    label: "Budget: per thread tree (USD)",
    default: "50",
  },
  "budget_perDayUsd": {
    type: "string",
    label: "Budget: per day (USD)",
    default: "500",
  },
  "eval_casesDir": {
    type: "string",
    label: "Eval cases directory",
    default: "~/.agents/eval/cases",
  },
  "eval_fixturesDir": {
    type: "string",
    label: "Eval fixtures directory",
    default: "~/fixtures",
  },
  "distillery_improvementsDir": {
    type: "string",
    label: "Distillery improvements directory",
    default: "~/.agents/improvements",
  },
  "distillery_monthlyBudgetUsd": {
    type: "string",
    label: "Distillery monthly drafting budget (USD)",
    default: "10",
  },
  "agents_optInProjects": {
    type: "string",
    label: "Agent instruction opt-in projects",
    description:
      "Comma-separated project ids whose threads receive the Observatory tool instructions.",
    default: "",
  },
} satisfies PluginSettingDescriptors;

/**
 * What core exposes to the CLI and, later, to the other modules. The handle is
 * filled by the core module's `setup` and stays null when core is disabled or
 * its setup tripped, which is exactly what the CLI must report.
 */
export interface CoreRuntime {
  store: ObservatoryStore;
  events: EventStore;
  ingest: Ingest;
  /**
   * Null when the log stack could not load. Exposed so `bb observatory index`
   * drives the SAME indexer as the scheduled pass rather than building a
   * second one over the same database.
   */
  indexer: LogIndexer | null;
  /** Null when the log stack is absent; then nothing downstream can price. */
  catalog: PricingCatalog | null;
}

export interface CoreHandle {
  current: CoreRuntime | null;
}

/**
 * The sibling log stack (parsers, pricing catalog, incremental indexer) is
 * OPTIONAL: without it the plugin still ingests bb events and still reports
 * turns, they just carry no cache split and no price. Loading it lazily is
 * what lets core come up on a machine with no provider logs at all, and what
 * keeps this seam honest about the one thing it cannot invent.
 */
export interface LogStack {
  logs: LogTurnSource;
  priceTurn: PriceTurnFn;
  catalog: PricingCatalog;
  indexer: LogIndexer;
  refreshCatalog(): Promise<PricingCatalog>;
}

/**
 * `store-logs` rows and the `join` ports describe the same table from two
 * sides, so the two shapes are reconciled here rather than in either module.
 * `provider_thread_id` is nullable in the row type and non-null in the port:
 * the query filters on an exact non-null id, so the queried value is the
 * exact value any returned row carries.
 */
function toLogTurnSource(store: LogStore): LogTurnSource {
  return {
    listLogTurns: (query) =>
      store.listLogTurns(query).map((row) => ({
        ...row,
        provider_thread_id: row.provider_thread_id ?? query.providerThreadId,
      })),
  };
}

async function loadLogStack(
  bb: BbPluginApi,
  db: ReturnType<BbPluginApi["storage"]["database"]>,
  options: { refreshHours: number; roots: readonly string[] },
): Promise<LogStack | null> {
  try {
    const store = new LogStore(db);
    let catalog = await loadCatalog(db, {
      refreshHours: options.refreshHours,
    });
    // The port hands pricing a catalog it types as `unknown`. The loaded
    // catalog is read through the getter instead, so a refresh takes effect
    // without re-threading it through every caller.
    const pricePort: PriceTurnFn = priceTurnPort(() => catalog);
    const indexer = createLogIndexer({
      store,
      host: new LocalHostClient(),
      roots: [...options.roots],
      log: bb.log,
    });
    return {
      logs: toLogTurnSource(store),
      priceTurn: pricePort,
      catalog,
      indexer,
      refreshCatalog: async () => {
        catalog = await loadCatalog(db, { refreshHours: 0 });
        return catalog;
      },
    };
  } catch (error) {
    bb.log.warn(
      `[core] log stack unavailable, cache splits stay unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function parseHours(value: string | boolean | undefined, fallback: number) {
  const parsed = Number.parseFloat(typeof value === "string" ? value : "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Retention days, from the setting, falling back to the advertised default. */
export function parseDays(value: string | boolean | undefined, fallback: number) {
  const parsed = Number.parseFloat(typeof value === "string" ? value : "");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The pass budget, from the setting, falling back to the measured default. */
function indexBudget(
  value: string | boolean | undefined,
): { maxBytes: number } {
  const parsed = Number.parseFloat(typeof value === "string" ? value : "");
  const megabytes =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INDEX_BUDGET_MB;
  return { maxBytes: Math.round(megabytes * 1024 * 1024) };
}

/**
 * Core: the only writer of the ledger. It owns the ingest service, the stale
 * reconcile, the log pass and the pricing refresh, and hands the CLI a handle
 * so `status`, `coverage` and `backfill` read the same objects the jobs use.
 */
export function createCoreModule(
  handle: CoreHandle,
  settings: () => Promise<Record<string, string | boolean | undefined>>,
  /**
   * Hooks other modules push onto, fired after a thread's turns commit. The
   * array is read per drain rather than captured, so a module registered
   * AFTER core still gets called.
   */
  commitHooks: ReadonlyArray<(threadId: string) => void> = [],
): ObservatoryModule {
  return defineModule({
    id: CORE_MODULE_ID,
    async setup(ctx) {
      const { bb } = ctx;
      const db = ctx.db();
      const store = new ObservatoryStore(db);
      const events = new EventStore(db);
      const values = await settings();
      const extraRoots = parseRoots(values["roots_extra"]);
      const roots = [...defaultLogRoots(), ...extraRoots];
      const stack = await loadLogStack(bb, db, {
        refreshHours: parseHours(values["pricing_refreshHours"], 24),
        roots,
      });

      const ingest = createIngest({
        bb,
        store,
        events,
        logs: stack?.logs ?? null,
        priceTurn: stack?.priceTurn ?? null,
        catalog: stack?.catalog,
        onThreadCommitted: (threadId) => {
          for (const hook of commitHooks) hook(threadId);
        },
      });
      handle.current = {
        store,
        events,
        ingest,
        indexer: stack?.indexer ?? null,
        catalog: stack?.catalog ?? null,
      };

      bb.background.service("ingest", {
        start: (signal) => ingest.start(signal),
      });
      bb.background.schedule(
        "reconcile",
        "*/1 * * * *",
        ctx.job("reconcile", async () => {
          await ingest.reconcileStale();
        }),
      );
      bb.background.schedule(
        "logs",
        "*/5 * * * *",
        ctx.job("logs", async () => {
          if (!stack) return;
          // Re-read every tick: the budget is the one setting a person reaches
          // for when a cold start is taking too long, and a reload to apply it
          // would drop the ingest subscription with it.
          const current = await settings();
          await stack.indexer.runOnce(
            indexBudget(current["index_budgetMb"]),
          );
          ingest.rejoinPending();
        }),
      );
      bb.background.schedule(
        "pricing",
        "0 */24 * * *",
        ctx.job("pricing", async () => {
          if (stack) await stack.refreshCatalog();
        }),
      );
      bb.background.schedule(
        "prune",
        "0 4 * * *",
        ctx.job("prune", async () => {
          // Re-read every tick like the log budget: retention is the setting
          // a person reaches for when the database outgrows its disk.
          const current = await settings();
          const deleted = store.prune({
            itemsDays: parseDays(current["retention_itemsDays"], 30),
            logTurnsDays: parseDays(current["retention_logTurnsDays"], 90),
            turnsDays: parseDays(current["retention_turnsDays"], 365),
          });
          const total =
            deleted.items +
            deleted.logTurns +
            deleted.turns +
            deleted.matches +
            deleted.meta;
          if (total > 0) {
            bb.log.info(
              `[core] prune deleted ${deleted.turns} turns, ` +
                `${deleted.items} items, ${deleted.logTurns} log turns, ` +
                `${deleted.matches} matches, ${deleted.meta} meta keys`,
            );
          }
        }),
      );
      bb.log.info(
        `[core] ingest registered over ${roots.length} log roots` +
          (stack ? "" : " (log stack absent)"),
      );
    },
  });
}

/**
 * What the spend surfaces read. It is a VIEW of what core wrote — spend owns
 * `obs_signal` rows tagged `spend` and nothing else — so the handle carries
 * the store rather than a second connection.
 */
export interface SpendRuntime {
  store: ObservatoryStore;
  catalog: PricingCatalog | null;
  ttlMinutes: number;
}

export interface SpendHandle {
  current: SpendRuntime | null;
}

function parseMinutes(value: string | boolean | undefined, fallback: number) {
  const parsed = Number.parseFloat(typeof value === "string" ? value : "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Spend: read-only over the ledger, with one write of its own — the
 * `cache-miss` and `prefix-changed` signals. Its detector runs on the ingest
 * commit hook rather than a timer, so a drilldown is current the moment the
 * turn that caused it landed, and its idempotence comes from the signal dedupe
 * key rather than from remembering what it already scanned.
 */
export function createSpendModule(
  core: CoreHandle,
  handle: SpendHandle,
  settings: () => Promise<Record<string, string | boolean | undefined>>,
  commitHooks: Array<(threadId: string) => void>,
): ObservatoryModule {
  return defineModule({
    id: "spend",
    async setup(ctx) {
      const runtime = core.current;
      if (!runtime) {
        // Core disabled or tripped: there is no ledger to analyze, and
        // pretending otherwise would serve an empty cost page as a real one.
        ctx.bb.log.warn("[spend] core is not running; rollups unavailable");
        return;
      }
      const values = await settings();
      handle.current = {
        store: runtime.store,
        catalog: runtime.catalog,
        ttlMinutes: parseMinutes(
          values["spend_cacheTtlMinutes"],
          DEFAULT_CACHE_TTL_MINUTES,
        ),
      };
      const scan = (threadId: string) => {
        const spend = handle.current;
        if (!spend) return;
        const deps = {
          db: spend.store.db,
          store: spend.store,
          catalog: spend.catalog,
          ttlMinutes: spend.ttlMinutes,
        };
        // Bounded to the last day. This runs on EVERY commit of every thread,
        // and the unbounded form rescanned the thread's whole history each
        // time, so a long-lived thread paid more per commit the older it got.
        // A day is safely wider than the gap between two commits, and the
        // first-turn correlate no longer depends on the loaded slice, so the
        // narrower window cannot mislabel a cause.
        detectCacheMisses(deps, { threadId, range: "1d" });
        scanFingerprints(deps, { threadId });
      };
      commitHooks.push((threadId) => {
        // `ctx.job` logs a throw and counts it against THIS module's breaker,
        // so a bad scan cannot reject into the drain loop or trip core.
        void ctx.job("cache-miss scan", () => scan(threadId))();
      });
      ctx.bb.log.info("[spend] rollups and cache-miss detector registered");
    },
  });
}

// ---------------------------------------------------------------------------
// Context and audit (phase 4).
//
// Both are read-mostly analyzers, and neither is on the ingest hot path: the
// context scan reads the filesystem on a daily schedule and on demand, and
// audit materializes everything it reports on request and stores nothing at
// all. That is why neither takes a commit hook — a hook is for work that must
// happen the moment a turn lands, and being one day stale about which skills
// are mounted costs nothing.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// eval
//
// Unlike spend, eval does not read the ledger for its INPUTS: those are case
// files under `eval_casesDir` and its own three tables. It reads `obs_turn`
// only to price a run it is already driving, so it needs no `CoreHandle` and
// stays useful when core is disabled — `eval validate` is the check an
// operator wants precisely when the rest of the plugin is unhappy.
//
// The nightly cron is the one thing here that can spend money on its own, so
// it is guarded twice: it runs only on the `smoke` tag, and only when the
// skill stack's HEAD or the case files actually moved.
// ---------------------------------------------------------------------------

export interface EvalRuntime {
  deps: EvalDeps;
  live: EvalLiveDeps;
  databasePath: string | undefined;
}

export interface EvalHandle {
  current: EvalRuntime | null;
}

export const DEFAULT_EVAL_CASES_DIR = "~/.agents/eval/cases";

/** The tag the nightly runs, and the only tag it will ever run. */
export const NIGHTLY_TAG = "smoke";

export function createEvalModule(
  db: () => Database,
  handle: EvalHandle,
  settings: () => Promise<Record<string, string | boolean | undefined>>,
  /**
   * Core's ingest, read late the way the watch module reads it: eval registers
   * after core, but core can be disabled or restarted under it, so the drain
   * is resolved per call rather than captured at setup.
   */
  ingest: () => Ingest | null,
): ObservatoryModule {
  return defineModule({
    id: "eval",
    async setup(ctx) {
      const values = await settings();
      const configured = values["eval_casesDir"];
      const casesDir =
        typeof configured === "string" && configured.trim() !== ""
          ? configured.trim()
          : DEFAULT_EVAL_CASES_DIR;
      const database = db();
      const runtime: EvalRuntime = {
        deps: { store: new EvalStore(database), casesDir },
        live: {
          bb: ctx.bb,
          db: database,
          drainThread: async (threadId) =>
            (await ingest()?.drainThread(threadId)) ?? 0,
        },
        databasePath: database.name,
      };
      handle.current = runtime;

      registerEvalNightly(ctx, runtime);
      ctx.bb.log.info(`[eval] registered over ${casesDir}`);
    },
  });
}

/**
 * The nightly smoke suite. It skips when neither `~/.agents` HEAD nor the
 * case files changed, because a nightly whose inputs are identical can only
 * reproduce last night's answer at full price.
 */
function registerEvalNightly(ctx: ModuleContext, runtime: EvalRuntime): void {
  ctx.bb.background.schedule(
    "eval-nightly",
    "0 3 * * *",
    ctx.job("eval-nightly", async () => {
      if (!(await ctx.enabled())) return;
      const current: NightlyFingerprint = {
        stackSha: stackSha("~/.agents"),
        casesHash: hashCasesDir(runtime.deps.casesDir),
      };
      const previous = await ctx.bb.storage.kv.get<NightlyFingerprint>(NIGHTLY_KV_KEY);
      if (!shouldRunNightly(current, previous)) {
        ctx.bb.log.info("[eval] nightly skipped: stack and cases unchanged");
        return;
      }
      // The fingerprint is written BEFORE the run, so a suite that crashes
      // halfway does not re-spend the whole night's budget on the next tick.
      await ctx.bb.storage.kv.set(NIGHTLY_KV_KEY, current);
      const result = await runEvalCommand(
        runtime.deps,
        ["run", "--tag", NIGHTLY_TAG, "--gate"],
        runtime.databasePath,
        runtime.live,
      );
      ctx.bb.log.info(
        `[eval] nightly finished with exit ${result.exitCode}\n${result.stdout ?? result.stderr ?? ""}`,
      );
    }),
  );
}

// --- end eval ---

/**
 * The tools this plugin mounts, as the context scan sees them.
 *
 * Every description here is charged to every session the plugin is enabled in,
 * so the scan measures them beside the skills and the MCP servers rather than
 * exempting the plugin from its own audit.
 */
export const CONTEXT_TOOL = {
  name: "observatory_context",
  description:
    "What this project's prompt prefix is made of: instructions, skills, MCP servers and plugin tools, with duplicates and dead skills. Optionally one thread's compaction estimate.",
} as const;

export const AUDIT_PACK_TOOL = {
  name: "observatory_audit_pack",
  description:
    "Session metrics against the 7-day median, verification coverage, unverified edits, failures and insight facets for a thread or deliver run folder. Read-only by default; pass export true to also write audit.json, audit.md and COST.md into the run folder and get their paths back.",
} as const;

export const FAILURES_TOOL = {
  name: "observatory_failures",
  description:
    "Top failure signatures across recent threads, with counts and when each was last seen.",
} as const;

/** A function, not a constant: `COST_TOOL` is declared further down the file. */
export function agentTools(): PluginToolDescriptor[] {
  return [COST_TOOL, CONTEXT_TOOL, AUDIT_PACK_TOOL, FAILURES_TOOL].map(
    (tool) => ({ name: tool.name, description: tool.description }),
  );
}

/** What the context surfaces read. Context owns its two tables and no others. */
export interface ContextRuntime {
  store: ObservatoryStore;
}

export interface ContextHandle {
  current: ContextRuntime | null;
}

/** Audit stores nothing, so its runtime is the ledger handle and a clock. */
export interface AuditHandle {
  current: { store: ObservatoryStore } | null;
}

/** Distinct working directories one daily scan will cover. */
const CONTEXT_SCAN_CWD_LIMIT = 20;

function contextDeps(handle: ContextHandle): ContextDeps {
  const runtime = handle.current;
  if (!runtime) throw new Error("context module is not running");
  return {
    db: runtime.store.db,
    store: runtime.store,
    pluginTools: agentTools(),
  };
}

function auditDeps(handle: AuditHandle): AuditDeps {
  const runtime = handle.current;
  if (!runtime) throw new Error("audit module is not running");
  return { db: runtime.store.db, store: runtime.store };
}

/**
 * Context: one scan of the prefix per project, daily and on demand.
 *
 * The daily pass exists so the composition table has a history to compare
 * against; the on-demand path is what a person and an agent both call, and it
 * rescans rather than serving the stored rows, because a stale answer about
 * which files are mounted is worse than no answer.
 */
export function createContextModule(
  core: CoreHandle,
  handle: ContextHandle,
): ObservatoryModule {
  return defineModule({
    id: "context",
    setup(ctx) {
      const runtime = core.current;
      if (!runtime) {
        ctx.bb.log.warn("[context] core is not running; scans unavailable");
        return;
      }
      handle.current = { store: runtime.store };
      ctx.bb.background.schedule(
        "context-scan",
        "0 3 * * *",
        ctx.job("context-scan", () => {
          const deps = contextDeps(handle);
          const cwds = deps.db
            .prepare<[number], { cwd: string }>(
              `SELECT DISTINCT cwd FROM obs_thread
                WHERE cwd IS NOT NULL
                ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT ?`,
            )
            .all(CONTEXT_SCAN_CWD_LIMIT);
          for (const row of cwds) {
            takeSnapshot(deps, { cwd: row.cwd, refresh: true });
          }
        }),
      );
      ctx.bb.log.info("[context] scan registered");
    },
  });
}

/** Audit: pure read of the ledger, plus the run-folder export. */
export function createAuditModule(
  core: CoreHandle,
  handle: AuditHandle,
): ObservatoryModule {
  return defineModule({
    id: "audit",
    setup(ctx) {
      const runtime = core.current;
      if (!runtime) {
        ctx.bb.log.warn("[audit] core is not running; reports unavailable");
        return;
      }
      handle.current = { store: runtime.store };
      ctx.bb.log.info("[audit] session, failure and insight reports registered");
    },
  });
}

export const CONTEXT_COMMANDS = ["context"] as const;
export const AUDIT_COMMANDS = ["audit", "failures", "insights"] as const;

/** `bb observatory context [surfaces] [--thread id] [--cwd path] [--json]`. */
export function runContextCommand(
  deps: () => ContextDeps,
  argv: readonly string[],
): { exitCode: number; stdout?: string; stderr?: string } {
  try {
    const resolved = deps();
    const threadId = flagValue(argv, "thread");
    if (threadId !== undefined) {
      const view = contextThread(resolved, threadId);
      return hasFlag(argv, "json")
        ? { exitCode: 0, stdout: `${JSON.stringify(view, null, 2)}\n` }
        : { exitCode: 0, stdout: `${formatThreadContext(view)}\n` };
    }
    const cwd = flagValue(argv, "cwd");
    const view = takeSnapshot(resolved, {
      ...(cwd === undefined ? {} : { cwd }),
      refresh: true,
    });
    if (hasFlag(argv, "json")) {
      return { exitCode: 0, stdout: `${JSON.stringify(view, null, 2)}\n` };
    }
    return argv[0] === "surfaces"
      ? { exitCode: 0, stdout: `${formatSurfaces(view)}\n` }
      : { exitCode: 0, stdout: `${formatContext(view)}\n` };
  } catch (error) {
    return {
      exitCode: 1,
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

/** `bb observatory audit|failures|insights`. */
export function runAuditCommand(
  deps: () => AuditDeps,
  command: (typeof AUDIT_COMMANDS)[number],
  argv: readonly string[],
): { exitCode: number; stdout?: string; stderr?: string } {
  try {
    const resolved = deps();
    if (command === "failures") {
      const rows = failureRows(resolved, {
        range: parseRange(flagValue(argv, "range")),
        includeMuted: hasFlag(argv, "include-muted"),
      });
      return hasFlag(argv, "json")
        ? { exitCode: 0, stdout: `${JSON.stringify(rows, null, 2)}\n` }
        : { exitCode: 0, stdout: `${formatFailures(rows)}\n` };
    }
    if (command === "insights") {
      const facets = auditInsights(resolved, parseRange(flagValue(argv, "range")));
      return hasFlag(argv, "json")
        ? { exitCode: 0, stdout: `${JSON.stringify(facets, null, 2)}\n` }
        : { exitCode: 0, stdout: `${formatInsights(facets)}\n` };
    }
    // The target is positional and first. Scanning for "the first argument
    // without dashes" would swallow a flag's VALUE — `--range 7d` would audit
    // a session called `7d`.
    const first = argv[0];
    const target = first?.startsWith("--") ? undefined : first;
    if (!target) {
      // No target is the "which session" question, so it is answered rather
      // than refused: the list is what a person picks an id out of.
      const rows = auditSessions(resolved, parseRange(flagValue(argv, "range")));
      return hasFlag(argv, "json")
        ? { exitCode: 0, stdout: `${JSON.stringify(rows, null, 2)}\n` }
        : { exitCode: 0, stdout: `${formatSessions(rows)}\n` };
    }
    // A run folder is a path, a thread id is not: nothing else distinguishes
    // the two, and asking the operator to say which would be a flag nobody
    // remembers.
    const isFolder = target.includes("/") || target.startsWith(".");
    if (hasFlag(argv, "pack")) {
      // Verbatim, unformatted: this surface exists so an operator can measure
      // what the agent tool returns, and pretty-printing would change it.
      // `--export` rides along the same way it does on the tool: without it
      // the pack is a read and leaves no files behind.
      const result = auditPackToolResult(
        resolved,
        isFolder ? { runFolder: target } : { threadId: target },
        { write: hasFlag(argv, "export") },
      );
      return { exitCode: 0, stdout: `${result}\n` };
    }
    const session = auditSession(
      resolved,
      isFolder ? { runFolder: target } : { threadId: target },
    );
    const written = hasFlag(argv, "export")
      ? session.runFolder
        ? writeAuditPack(resolved, session.runFolder)
        : []
      : [];
    const body = hasFlag(argv, "json")
      ? `${JSON.stringify(session, null, 2)}\n`
      : `${formatSession(session)}\n`;
    const tail =
      hasFlag(argv, "export") && written.length === 0
        ? "no run folder resolved; nothing exported\n"
        : written.map((path) => `wrote ${path}\n`).join("");
    return { exitCode: 0, stdout: `${body}${tail}` };
  } catch (error) {
    return {
      exitCode: 1,
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

/**
 * Core writes the ledger, watch analyzes it, and the rest are still stubs
 * landing in later phases behind these seams. Registration order matters:
 * watch takes core's ingest handle, so core must have set it up first.
 */
export function buildModules(
  handle: CoreHandle,
  settings: () => Promise<Record<string, string | boolean | undefined>>,
  spend: SpendHandle = { current: null },
  commitHooks: Array<(threadId: string) => void> = [],
  watch: WatchHandle = { current: null },
  context: ContextHandle = { current: null },
  audit: AuditHandle = { current: null },
  distillery: DistilleryHandle = { current: null },
  evalModule?: { db: () => Database; handle: EvalHandle },
): readonly ObservatoryModule[] {
  return MODULE_IDS.map((id) => {
    if (id === CORE_MODULE_ID) return createCoreModule(handle, settings, commitHooks);
    if (id === "spend") return createSpendModule(handle, spend, settings, commitHooks);
    if (id === "watch") {
      return createWatchModule({
        handle: watch,
        ingest: () => handle.current?.ingest ?? null,
        settings,
      });
    }
    if (id === "context") return createContextModule(handle, context);
    if (id === "audit") return createAuditModule(handle, audit);
    if (id === "eval" && evalModule !== undefined) {
      return createEvalModule(evalModule.db, evalModule.handle, settings, () =>
        handle.current?.ingest ?? null,
      );
    }
    if (id === "distillery") {
      return createDistilleryModule({ handle: distillery, settings });
    }
    return defineModule({
      id,
      setup(ctx) {
        ctx.bb.log.info(`[${id}] registered`);
      },
    });
  });
}

const USAGE = [
  "Usage: bb observatory <command>",
  "",
  "  status     Module states, breaker counts, store counts, settings",
  "  doctor     Database, migrations, and provider log roots",
  "  coverage   Turn split coverage: log-exact, log-window, sidechain, n/a",
  "  index      Run log index passes now: [--budget-mb N] [--passes N]",
  "  backfill   Drain history and re-join it: --since <ISO|Nd> [--provider p]",
  "             --reset  re-read every event; rebuilds derived rows, never",
  "                      touches provider logs",
  "  cost       Priced rollups: --range 1d|7d|30d|90d --group lineage|model|day",
  "             --tree <threadId>  per-turn split for one thread",
  "             --run <folder>     only threads attributed to that run folder",
  "             --json             the rpc object, unformatted",
  "  cost-md    Write COST.md for a run folder: cost-md <runFolder>",
  "             [--snapshot final|mid-run] [--stdout]",
  "  cache-misses  Prefix drops and their cause: [--range 7d] [--thread <id>]",
  "  watch      Stall state per active thread: [--follow] [--json]",
  "             explain <threadId>   signals and actions for one thread",
  "             off|observe|steer    set the watch mode (stored in kv)",
  "             steer <threadId> [--note <text>]     steer one thread by hand",
  "             escalate <threadId> [--note <text>]  steer its parent instead",
  "  context    Prompt-prefix composition: [surfaces] [--cwd path]",
  "             [--thread <id>]  one thread's compaction estimate",
  "             [--json]",
  "  audit      One session against the 7d median: audit <threadId|runFolder>",
  "             with no target, the sessions list: [--range 7d]",
  "             [--json] [--export] [--pack]",
  "  failures   Failure signatures by count: [--range 7d] [--include-muted]",
  "  insights   Cost drivers, models and failure signatures: [--range 7d]",
  // --- eval ---
  "  eval       Deliver-stack regression cases: eval <list|validate|show|run>",
  "             run --dry-run [--tag t] [--case n] [--keep]  provisions and",
  "                      prints the plan; spawns nothing",
  // --- end eval ---
  "  distill    Recurring delivery failures, mined into reviewable harness fixes:",
  "             scan [--run <folder>]  mine every signal source",
  "             list [--state <s>]     the review queue",
  "             show <id>              one draft with its evidence",
  "             accept|reject|apply <id>",
  "             edit <id> --file <json>",
  "             draft                  spawn one hidden drafting batch (spends)",
].join("\n");

export interface StatusDeps {
  bb: BbPluginApi;
  store: ObservatoryStore;
  registry: ModuleRegistry;
  settings(): Promise<Record<string, string | boolean | undefined>>;
  now(): string;
}

/** The one status builder. The CLI formats this; the rpc returns it as is. */
export async function buildStatus(deps: StatusDeps): Promise<StatusView> {
  const values = await deps.settings();
  const modules: ModuleState[] = [];
  for (const id of MODULE_IDS) {
    const breaker = deps.registry.breaker(id);
    const override = await deps.bb.storage.kv.get<boolean>(
      moduleEnabledKvKey(id),
    );
    const setting = values[moduleEnabledSettingKey(id)];
    const source =
      typeof override === "boolean"
        ? "kv"
        : typeof setting === "boolean" || typeof setting === "string"
          ? "setting"
          : "default";
    const enabled =
      !breaker.tripped &&
      (typeof override === "boolean" ? override : isEnabledSetting(setting));
    modules.push({
      id,
      enabled,
      source,
      failures: breaker.failures,
      tripped: breaker.tripped,
      lastError: breaker.lastError,
    });
  }
  const settings = Object.keys(SETTING_DESCRIPTORS)
    .filter((key) => !key.startsWith("modules_"))
    .map((key) => ({ key, value: String(values[key] ?? "") }));
  return {
    pluginId: deps.bb.pluginId,
    version: VERSION,
    installed: installedPath(),
    modules,
    counts: deps.store.counts(),
    settings,
    generatedAt: deps.now(),
  };
}

export function formatStatus(
  status: StatusView,
  ingest?: IngestCounters | null,
): string {
  const lines = [
    `observatory ${status.version}`,
    `installed ${status.installed}`,
    "",
    "modules",
  ];
  for (const module of status.modules) {
    const state = module.tripped
      ? `tripped (${module.failures} failures)`
      : module.enabled
        ? "on"
        : "off";
    lines.push(
      `  ${module.id.padEnd(11)} ${state.padEnd(24)} source ${module.source}` +
        (module.lastError ? `  last error: ${module.lastError}` : ""),
    );
  }
  lines.push("", "store");
  for (const [key, value] of Object.entries(status.counts)) {
    lines.push(`  ${key.padEnd(11)} ${value}`);
  }
  lines.push("", "settings");
  for (const setting of status.settings) {
    lines.push(`  ${setting.key.padEnd(28)} ${setting.value}`);
  }
  if (ingest) {
    lines.push("", "ingest");
    for (const [key, value] of [
      ["dirty", String(ingest.dirty)],
      ["drains", String(ingest.drains)],
      ["events", String(ingest.events)],
      ["last drain", ingest.lastDrainAt ?? "never"],
      ["last reconcile", ingest.lastReconcileAt ?? "never"],
      ["last logs pass", ingest.lastLogsPassAt ?? "never"],
    ] as const) {
      lines.push(`  ${key.padEnd(28)} ${value}`);
    }
  }
  return lines.join("\n");
}

/** `--since 7d`, `--since 2026-09-01`. Returns epoch ms. */
export function parseSince(value: string | undefined, now: number): number {
  if (!value) return now - 7 * 24 * 60 * 60 * 1_000;
  const relative = /^(\d+)d$/u.exec(value.trim());
  if (relative) {
    return now - Number(relative[1]) * 24 * 60 * 60 * 1_000;
  }
  const parsed = Date.parse(value);
  // An unparseable --since would silently backfill everything, so it is the
  // caller's error rather than a default.
  if (Number.isNaN(parsed)) throw new Error(`unparseable --since: ${value}`);
  return parsed;
}

export function formatCoverage(
  coverage: CoverageView,
  byProvider: readonly ProviderCoverageView[] = [],
): string {
  const share = (n: number) =>
    coverage.turns === 0 ? "  n/a" : `${((n / coverage.turns) * 100).toFixed(1)}%`;
  const lines = [
    `turns          ${coverage.turns}`,
    `log-exact      ${coverage.logExact} (${share(coverage.logExact)})`,
    `log-window     ${coverage.logWindow} (${share(coverage.logWindow)})`,
    `sidechain      ${coverage.sidechain}`,
    `unavailable    ${coverage.unavailable} (${share(coverage.unavailable)})`,
  ];
  // The exactness bar is a per-provider bar: one provider without a log
  // parser drags the whole-ledger number under it and hides a healthy one.
  if (byProvider.length > 0) {
    lines.push("", "by provider    turns  log-exact  log-window  n/a");
    for (const row of byProvider) {
      const pct =
        row.turns === 0
          ? "  n/a"
          : `${((row.logExact / row.turns) * 100).toFixed(1)}%`;
      lines.push(
        `  ${row.provider.padEnd(13)}${String(row.turns).padStart(4)}  ` +
          `${String(row.logExact).padStart(6)} ${pct.padStart(7)}  ` +
          `${String(row.logWindow).padStart(9)}  ${String(row.unavailable).padStart(4)}`,
      );
    }
  }
  return lines.join("\n");
}

/** `--provider codex` style flags. Absent flag returns undefined. */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  // `--provider --reset` is a missing value, not a provider named "--reset".
  return value === undefined || value.startsWith("--") ? undefined : value;
}

/** `--reset` style switches, which carry no value. */
export function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export function runDoctor(
  store: ObservatoryStore,
  extraRoots: readonly string[],
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  try {
    store.db.prepare("SELECT 1").get();
    checks.push({ name: "database", ok: true, detail: "opens" });
  } catch (error) {
    checks.push({
      name: "database",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const tables = store.db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'obs_%'",
      )
      .all();
    checks.push({
      name: "migrations",
      ok: tables.length > 0,
      detail: `${tables.length} ledger tables`,
    });
  } catch (error) {
    checks.push({
      name: "migrations",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const roots = [
    ...DEFAULT_LOG_ROOTS,
    ...extraRoots.map((path) => ({ provider: "extra", path })),
  ];
  for (const root of roots) {
    const resolved = expandHome(root.path);
    const exists = existsSync(resolved);
    checks.push({
      name: `root ${root.provider}`,
      ok: exists,
      detail: `${resolved} exists ${exists ? "yes" : "no"}`,
    });
  }
  return checks;
}

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  return checks
    .map((check) => `${check.ok ? "ok  " : "warn"} ${check.name.padEnd(20)} ${check.detail}`)
    .join("\n");
}

function parseRoots(value: string | boolean | undefined): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The cap bb applies to a tool's own text, reused as the ceiling on this
 * tool's RESULT. A cost report is the kind of payload that grows without
 * bound (one row per turn of a long run), and a tool result that fills the
 * context is worse than one that says it was truncated.
 */
export const TOOL_RESULT_LIMIT = 4096;

/**
 * The agent-facing tool's text, exported so its budget is asserted rather than
 * hoped for. One tool with one scope enum: a model handed five cost tools
 * calls the wrong one, and every character here is charged to every session
 * the tool is mounted in.
 */
export const COST_TOOL = {
  name: "observatory_cost",
  description:
    "Cost, tokens and cache split for a bb thread, its subtree, or a deliver run folder. Returns compact JSON.",
} as const;

/**
 * The tool result, never longer than the cap and always parseable JSON.
 *
 * The body is shrunk, never the serialization. Escaping means a body of N
 * characters serializes to MORE than N, so a room figure computed once
 * undershoots, and slicing the finished JSON to the cap cuts the closing
 * brace off - handing the model a truncation notice it cannot parse, which is
 * strictly worse than no result at all.
 */
export function clampToolResult(payload: unknown): string {
  const full = JSON.stringify(payload);
  if (full.length <= TOOL_RESULT_LIMIT) return full;
  let body = full;
  for (;;) {
    const envelope = JSON.stringify({ truncated: true, body });
    const over = envelope.length - TOOL_RESULT_LIMIT;
    if (over <= 0) return envelope;
    if (body.length === 0) return JSON.stringify({ truncated: true, body: "" });
    body = body.slice(0, Math.max(0, body.length - over));
  }
}

/**
 * The audit pack exactly as the agent tool returns it.
 *
 * One function behind three callers - the agent tool, the rpc and
 * `bb observatory audit <target> --pack` - so the tool's 4096-char contract is
 * checkable from a terminal instead of only from inside a model's turn.
 */
export function auditPackToolResult(
  deps: AuditDeps,
  target: AuditTarget,
  options: { write?: boolean } = {},
): string {
  return clampToolResult(auditPackWithExport(deps, target, options));
}

/**
 * Whether the ledger attributes at least one thread to this run folder: one
 * parameterized EXISTS, so gating an operator-supplied folder never loads
 * every attributed folder to test one id.
 */
export function isKnownRunFolder(db: Database, folder: string): boolean {
  return (
    db
      .prepare<[string], { one: number }>(
        `SELECT 1 AS one FROM obs_thread WHERE run_folder = ? LIMIT 1`,
      )
      .get(folder) !== undefined
  );
}

/**
 * The rows of one thread's whole subtree.
 *
 * A lineage row's `parentKey` is the key of the row above it, and the seat
 * rows in between carry synthetic keys like `<root>:seat:<seat>`. Matching
 * `parentKey === id` therefore stops one level down and drops every leaf; the
 * relation has to be followed transitively. The rows arrive parent-first, but
 * the fixpoint does not rely on that.
 */
export function subtreeRows(
  rows: readonly SpendRow[],
  id: string,
): SpendRow[] {
  const keys = new Set<string>([id]);
  for (;;) {
    const before = keys.size;
    for (const row of rows) {
      if (row.parentKey !== undefined && keys.has(row.parentKey)) {
        keys.add(row.key);
      }
    }
    if (keys.size === before) break;
  }
  return rows.filter((row) => keys.has(row.key));
}

const RANGES: readonly SpendRange[] = ["1d", "7d", "30d", "90d"];
const GROUPS: readonly SpendGroup[] = ["lineage", "model", "day"];

/** An unrecognized range would silently widen the bill, so it is an error. */
export function parseRange(value: string | undefined): SpendRange {
  if (value === undefined) return "7d";
  const found = RANGES.find((range) => range === value);
  if (!found) throw new Error(`--range must be one of ${RANGES.join(", ")}`);
  return found;
}

export function parseGroup(value: string | undefined): SpendGroup {
  if (value === undefined) return "lineage";
  const found = GROUPS.find((group) => group === value);
  if (!found) throw new Error(`--group must be one of ${GROUPS.join(", ")}`);
  return found;
}

export function parseSnapshot(value: string | undefined): Snapshot | undefined {
  if (value === undefined) return undefined;
  if (value !== "final" && value !== "mid-run") {
    throw new Error("--snapshot must be final or mid-run");
  }
  return value;
}

export function formatThread(view: SpendThreadView): string {
  const number = (value: number | null) =>
    value === null ? "n/a" : String(value);
  const lines = [
    `${view.thread.title} (${view.thread.threadId})`,
    `provider ${view.thread.provider}  seat ${view.thread.seat ?? "n/a"}`,
    `spend ${view.totals.spendUsd.toFixed(4)}  cache saved ${view.totals.cacheSavedUsd.toFixed(4)}`,
    "",
    `${"started".padEnd(26)} ${"model".padEnd(28)} ${"in".padStart(9)} ${"read".padStart(9)} ${"out".padStart(9)} ${"usd".padStart(9)}  flags`,
  ];
  for (const turn of view.turns) {
    lines.push(
      `${turn.startedAt.padEnd(26)} ${(turn.modelReported ?? "n/a")
        .slice(0, 28)
        .padEnd(28)} ${number(turn.inputTokens).padStart(9)} ${number(
        turn.cacheReadTokens,
      ).padStart(9)} ${number(turn.outputTokens).padStart(9)} ${(turn.costUsd ===
      null
        ? "n/a"
        : turn.costUsd.toFixed(4)
      ).padStart(9)}  ${turn.flags.join(" ")}`,
    );
  }
  if (view.turns.length === 0) lines.push("  (no turns)");
  if (view.truncated) {
    lines.push(`  (showing the first ${SPEND_ROW_LIMIT} turns)`);
  }
  return lines.join("\n");
}

export function formatCacheMisses(rows: readonly CacheMissRow[]): string {
  if (rows.length === 0) return "no cache misses in range";
  const lines = [
    `${"at".padEnd(26)} ${"thread".padEnd(24)} ${"drop".padStart(10)} ${"usd".padStart(8)} ${"n7d".padStart(4)}  cause`,
  ];
  for (const row of rows) {
    lines.push(
      `${row.at.padEnd(26)} ${row.threadId.slice(0, 24).padEnd(24)} ${String(
        row.drop,
      ).padStart(10)} ${(row.estimatedUsd === null
        ? "n/a"
        : row.estimatedUsd.toFixed(4)
      ).padStart(8)} ${String(row.recurrence7d).padStart(4)}  ${row.cause}`,
    );
  }
  return lines.join("\n");
}

export const SPEND_COMMANDS = ["cost", "cost-md", "cache-misses"] as const;
export type SpendCommand = (typeof SPEND_COMMANDS)[number];

/**
 * The three spend subcommands, together because they share one failure mode:
 * the spend module not running. Raising that once here is what keeps each
 * command from having to decide what an absent ledger prints.
 */
export function runSpendCommand(
  spendDeps: () => RollupDeps & { store: ObservatoryStore; ttlMinutes: number },
  command: SpendCommand,
  argv: readonly string[],
): { exitCode: number; stdout?: string; stderr?: string } {
  try {
    const deps = spendDeps();
    if (command === "cache-misses") {
      const threadId = flagValue(argv, "thread");
      const rows = detectCacheMisses(deps, {
        range: parseRange(flagValue(argv, "range")),
        ...(threadId === undefined ? {} : { threadId }),
      });
      return hasFlag(argv, "json")
        ? { exitCode: 0, stdout: `${JSON.stringify(rows, null, 2)}\n` }
        : { exitCode: 0, stdout: `${formatCacheMisses(rows)}\n` };
    }
    if (command === "cost-md") {
      const folder = argv.find((entry) => !entry.startsWith("--"));
      if (!folder) {
        return { exitCode: 1, stderr: "cost-md needs a run folder\n" };
      }
      // `buildCostMd` reads `<folder>/LEDGER.md` from disk, so an unchecked
      // folder makes this command an arbitrary-file read. The agent tool
      // applies the same gate; the CLI must not be the way around it.
      if (!isKnownRunFolder(deps.db, folder)) {
        return {
          exitCode: 1,
          stderr: `no such run folder in the ledger: ${folder}\n`,
        };
      }
      const snapshot = parseSnapshot(flagValue(argv, "snapshot"));
      const report = buildCostMd(deps.db, {
        runFolder: folder,
        ...(snapshot === undefined ? {} : { snapshot }),
      });
      if (hasFlag(argv, "stdout")) {
        return { exitCode: 0, stdout: report.content };
      }
      // `folder` is operator input: route the write through the same
      // inside-the-run-folder guard the audit export uses.
      const target = assertInside(folder, report.filename);
      writeFileSync(target, report.content, "utf8");
      return {
        exitCode: 0,
        stdout: `wrote ${target} (${report.agents} agents, ${report.snapshot})\n`,
      };
    }
    const tree = flagValue(argv, "tree");
    if (tree !== undefined) {
      const view = spendThread(deps, tree);
      return hasFlag(argv, "json")
        ? { exitCode: 0, stdout: `${JSON.stringify(view, null, 2)}\n` }
        : { exitCode: 0, stdout: `${formatThread(view)}\n` };
    }
    const provider = flagValue(argv, "provider");
    const runFolder = flagValue(argv, "run");
    const query: OverviewQuery = {
      range: parseRange(flagValue(argv, "range")),
      group: parseGroup(flagValue(argv, "group")),
      ...(provider === undefined ? {} : { provider }),
      ...(runFolder === undefined ? {} : { runFolder }),
    };
    const overview = spendOverview(deps, query);
    return hasFlag(argv, "json")
      ? { exitCode: 0, stdout: `${JSON.stringify(overview, null, 2)}\n` }
      : { exitCode: 0, stdout: `${formatOverview(overview)}\n` };
  } catch (error) {
    // A bad flag and an absent module are both the operator's answer, not a
    // crash: the CLI is the surface people reach for when something is wrong.
    return {
      exitCode: 1,
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
}

/** Threads per `threads.list` page during a backfill. */
const BACKFILL_PAGE = 500;
/** Upper bound on drain passes, so an unreadable thread cannot loop forever. */
const BACKFILL_MAX_PASSES = 100;

/**
 * Walk thread history backwards and drain each thread, then re-join. Unlike
 * the scheduled pass this has no byte budget: a backfill is explicitly asked
 * for, and stopping halfway would leave a coverage number nobody can read.
 */
async function backfill(
  bb: BbPluginApi,
  runtime: CoreRuntime,
  argv: readonly string[],
): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  let since: number;
  try {
    since = parseSince(flagValue(argv, "since"), Date.now());
  } catch (error) {
    return {
      exitCode: 1,
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    };
  }
  const provider = flagValue(argv, "provider");
  const reset = hasFlag(argv, "reset");
  if (provider !== undefined) {
    // A typo used to select zero threads and print a healthy-looking empty
    // coverage report. The known ids are the log roots plus every provider
    // the ledger has actually seen.
    const seen = runtime.store.db
      .prepare<[], { provider_id: string | null }>(
        `SELECT DISTINCT provider_id FROM obs_thread WHERE provider_id IS NOT NULL`,
      )
      .all()
      .map((row) => row.provider_id as string);
    const known = [...new Set([...DEFAULT_LOG_ROOTS.map((root) => root.provider), ...seen])].sort();
    if (!known.includes(provider)) {
      return {
        exitCode: 1,
        stderr: `unknown provider "${provider}" (known: ${known.join(", ") || "none"})\n`,
      };
    }
  }
  // Page the thread list. A single 500-row request silently truncated the
  // backfill on any bb install with more history than that, and the coverage
  // number it printed looked complete.
  const selected: string[] = [];
  for (let offset = 0; ; offset += BACKFILL_PAGE) {
    const page = await bb.sdk.threads.list({
      includeHidden: true,
      limit: BACKFILL_PAGE,
      offset,
    });
    if (page.length === 0) break;
    for (const thread of page) {
      if (thread.createdAt < since) continue;
      if (provider !== undefined && thread.providerId !== provider) continue;
      selected.push(thread.id);
    }
    if (page.length < BACKFILL_PAGE) break;
  }
  const drained = selected.length;
  // A plain backfill resumes from each thread's watermark, so an event already
  // folded in is never re-read — which means a column the ledger learned to
  // keep only AFTER that thread was drained stays empty forever. `--reset`
  // rewinds the watermark so the whole history is re-derived.
  if (reset) runtime.ingest.reset(selected);
  else for (const threadId of selected) runtime.ingest.markDirty(threadId);
  // Drain thread by thread, not as one batch: one unreadable thread used to
  // end the whole backfill early via the shrinking-dirty test, and nothing
  // said which thread it was. A failure is recorded and the loop moves on;
  // failed threads are retried while other threads still make progress, and
  // a second consecutive failure without progress ends the loop instead of
  // burning all 100 passes on a dead thread.
  const failures = new Map<string, string>();
  let pending = [...selected];
  for (let pass = 0; pass < BACKFILL_MAX_PASSES; pass += 1) {
    const next: string[] = [];
    let ingested = 0;
    let freshFailure = false;
    for (const threadId of pending) {
      try {
        const count = await runtime.ingest.drainThread(threadId);
        ingested += count;
        failures.delete(threadId);
        if (count > 0) next.push(threadId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!failures.has(threadId)) freshFailure = true;
        failures.set(threadId, message);
        next.push(threadId);
      }
    }
    pending = next;
    if (pending.length === 0) break;
    if (ingested === 0 && !freshFailure) break;
  }
  // The whole history, not just turns still settling: a backfill exists to
  // re-prove what an earlier, premature pass got wrong.
  runtime.ingest.rejoinPending(true);
  const failureLine =
    failures.size === 0
      ? ""
      : `\nbackfill failures (${failures.size}): ${[...failures.keys()]
          .slice(0, 10)
          .join(", ")}${failures.size > 10 ? ", …" : ""}`;
  return {
    // A backfill that names failures failed: exit 0 would let a schedule
    // report healthy while threads sit undrained.
    exitCode: failures.size === 0 ? 0 : 1,
    stdout: `backfilled ${drained} threads since ${new Date(since).toISOString()}${failureLine}\n${formatCoverage(
      runtime.events.coverage(provider ?? null),
      runtime.events.coverageByProvider(provider ?? null),
    )}\n`,
  };
}

/**
 * Run index passes on demand.
 *
 * The scheduled pass runs every five minutes and stops at its budget, which
 * makes "did the indexer reach OpenCode yet" a question nobody can answer
 * without waiting. This answers it: it drives the same indexer, reports what
 * each pass moved, and stops early once a pass reports `done`, because a pass
 * with nothing left to read is the answer.
 */
async function indexNow(
  runtime: CoreRuntime,
  argv: readonly string[],
  budgetSetting: string | boolean | undefined,
): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const indexer = runtime.indexer;
  if (!indexer) {
    return { exitCode: 1, stderr: "log stack is not loaded\n" };
  }
  const budgetMb = flagValue(argv, "budget-mb");
  const budget = indexBudget(budgetMb ?? budgetSetting);
  const passesRaw = Number.parseInt(flagValue(argv, "passes") ?? "1", 10);
  const passes =
    Number.isFinite(passesRaw) && passesRaw > 0 ? Math.min(passesRaw, 100) : 1;

  const lines: string[] = [];
  let files = 0;
  let rows = 0;
  for (let pass = 1; pass <= passes; pass += 1) {
    const started = Date.now();
    const result = await indexer.runOnce(budget);
    files += result.files;
    rows += result.rows;
    lines.push(
      `pass ${pass}  files ${result.files}  rows ${result.rows}  ` +
        `${Date.now() - started}ms  ${result.done ? "done" : "more pending"}`,
    );
    if (result.done) break;
  }
  lines.push(
    `total   files ${files}  rows ${rows}  budget ${Math.round(
      budget.maxBytes / (1024 * 1024),
    )}MB per pass`,
  );
  // New rows are only worth anything once a turn claims them. The scheduled
  // job always pairs the two, and an operator running the index by hand to
  // explain a missing split got the rows without the join that consumes them.
  const join = runtime.ingest.rejoinPending();
  if (join) {
    lines.push(
      `join    log-exact ${join.logExact}  log-window ${join.logWindow}  ` +
        `sidechain ${join.sidechain}  unavailable ${join.unavailable}`,
    );
  }
  return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
}

export default async function observatory(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define(SETTING_DESCRIPTORS);
  const readSettings = async (): Promise<
    Record<string, string | boolean | undefined>
  > => (await settings.get()) as Record<string, string | boolean | undefined>;

  const db = bb.storage.database();
  applyMigrations(db, (database, statements) =>
    bb.storage.migrate(database, statements),
  );
  const store = new ObservatoryStore(db);

  const core: CoreHandle = { current: null };
  const spend: SpendHandle = { current: null };
  const context: ContextHandle = { current: null };
  const audit: AuditHandle = { current: null };
  const evalHandle: EvalHandle = { current: null };
  const commitHooks: Array<(threadId: string) => void> = [];
  const watch: WatchHandle = { current: null };
  const distillery: DistilleryHandle = { current: null };
  const registry = new ModuleRegistry({
    bb,
    db: () => db,
    settings: readSettings,
  });
  await registry.register(
    buildModules(core, readSettings, spend, commitHooks, watch, context, audit, distillery, {
      db: () => db,
      handle: evalHandle,
    }),
  );

  /** Every spend surface refuses rather than serving an empty page as a real one. */
  const spendDeps = () => {
    const runtime = spend.current;
    if (!runtime) throw new Error("spend module is not running");
    return {
      db: runtime.store.db,
      store: runtime.store,
      catalog: runtime.catalog,
      ttlMinutes: runtime.ttlMinutes,
    };
  };

  const status = () =>
    buildStatus({
      bb,
      store,
      registry,
      settings: readSettings,
      now: () => new Date().toISOString(),
    });

  bb.rpc.register(observatoryContract, {
    "observatory_status": () => status(),
  });

  // --- eval (part 1: cases, dry run, reads) ---
  /** Same refusal as spend: a disabled module serves nothing, not an empty page. */
  const evalDeps = (): EvalDeps => {
    const runtime = evalHandle.current;
    if (!runtime) throw new Error("eval module is not running");
    return runtime.deps;
  };

  bb.rpc.register(evalContract, {
    "observatory_eval_cases": () => {
      const deps = evalDeps();
      return casesView(deps, loadCases(deps));
    },
    "observatory_eval_runs": ({ limit }) => runsView(evalDeps(), limit),
    "observatory_eval_run": ({ runId }) => runView(evalDeps(), runId),
    "observatory_eval_baseline": () => baselineView(evalDeps()),
  });
  // --- end eval ---

  bb.rpc.register(spendContract, {
    "observatory_spend_overview": (input) => spendOverview(spendDeps(), input),
    "observatory_spend_thread": ({ threadId }) =>
      spendThread(spendDeps(), threadId),
    "observatory_spend_cache_misses": ({ range, threadId }) => ({
      rows: detectCacheMisses(spendDeps(), {
        range,
        ...(threadId === undefined ? {} : { threadId }),
      }),
    }),
    "observatory_spend_today": () => spendToday(spendDeps()),
    "observatory_spend_export": (input) => spendExport(spendDeps(), input),
    // The absorbed footer strip. `bb.sdk` shapes the ports structurally, so
    // the ported loader needs no adapter.
    "observatory_usage": ({ threadId }) => loadUsageSnapshot(bb.sdk, threadId),
    "observatory_usage_preferences": async () => {
      const values = await readSettings();
      return usagePreferences({
        claudeCode: values["usage_enableClaudeCode"] !== false,
        codex: values["usage_enableCodex"] !== false,
        compactLimit: values["usage_compactLimit"],
      });
    },
  });

  const contextRpcDeps = () => contextDeps(context);
  const auditRpcDeps = () => auditDeps(audit);

  bb.rpc.register(contextContract, {
    // Always a fresh scan: the panel asks this question to find out what is
    // mounted right now, and `refresh` decides whether the answer opens a new
    // snapshot row or updates the current hour's.
    "observatory_context_snapshot": (input) =>
      takeSnapshot(contextRpcDeps(), input),
    "observatory_context_thread": ({ threadId }) =>
      contextThread(contextRpcDeps(), threadId),
  });

  bb.rpc.register(auditContract, {
    "observatory_audit_sessions": ({ range }) => ({
      rows: auditSessions(auditRpcDeps(), range),
    }),
    "observatory_audit_session": (input) => auditSession(auditRpcDeps(), input),
    "observatory_audit_failures": ({ range, includeMuted }) => ({
      rows: failureRows(auditRpcDeps(), { range, includeMuted }),
    }),
    "observatory_audit_failure_mute": ({ signature, untilIso }) => {
      muteFailure(auditRpcDeps().store, signature, untilIso);
      return { signature, untilIso };
    },
    "observatory_audit_insights": ({ range }) => ({
      facets: auditInsights(auditRpcDeps(), range),
    }),
    "observatory_audit_export": ({ format, ...target }) =>
      auditExport(auditRpcDeps(), target, format),
    "observatory_audit_pack": (target) => ({
      result: auditPackToolResult(auditRpcDeps(), target),
    }),
  });

  // The agent-facing view of the same rollups. Kept to one tool with one
  // scope enum: a model given five cost tools calls the wrong one.
  bb.agents.registerTool({
    name: COST_TOOL.name,
    description: COST_TOOL.description,
    parameters: z
      .object({
        scope: z.enum(["thread", "tree", "run"]),
        id: z
          .string()
          .min(1)
          .describe("Thread id for thread/tree, run folder path for run."),
      })
      .strict(),
    execute({ scope, id }) {
      const deps = spendDeps();
      if (scope === "run") {
        // `buildCostMd` reads `<id>/LEDGER.md` from disk, so an unchecked id
        // makes this tool an arbitrary-file read on the model's say-so. Only
        // run folders the ledger already attributes turns to are accepted.
        if (!isKnownRunFolder(deps.db, id)) {
          return `no such run folder in the ledger: ${id}`;
        }
        const report = buildCostMd(deps.db, { runFolder: id });
        return clampToolResult({
          scope,
          id,
          agents: report.agents,
          snapshot: report.snapshot,
          costMd: report.content,
        });
      }
      const view = spendThread(deps, id);
      if (scope === "thread") {
        return clampToolResult({
          scope,
          threadId: id,
          // `agentTotals`, not the raw totals: a `0` here is read as a
          // measurement, and an unpriced model has no measurement.
          totals: agentTotals(view.totals),
          turns: view.turns.length,
        });
      }
      const tree = spendOverview(deps, { range: "90d", group: "lineage" });
      return clampToolResult({
        scope,
        threadId: id,
        rows: subtreeRows(tree.rows, id),
      });
    },
  });
  // ---- watch module surface (phase 2) --------------------------------------
  // Kept in one block so a concurrent edit elsewhere in this file merges
  // cleanly. Everything below reaches watch through `src/watch/index.ts`.
  bb.rpc.register(watchContract, createWatchRpcHandlers(bb, watch));

  const trajectory = createTrajectory({ db });
  bb.agents.registerTool({
    name: "observatory_trajectory",
    description:
      "Per-turn trajectory of a bb thread with OSCILLATION, LOOP and " +
      "CONTEXT RESET markers plus waste attribution. Read your own run " +
      "before deciding you are stuck.",
    parameters: z
      .object({ threadId: z.string().describe("bb thread id") })
      .strict(),
    execute: ({ threadId }) => ({
      content: [{ type: "text", text: trajectory.render(threadId) }],
    }),
  });
  // ---- end watch module surface --------------------------------------------

  // Context and audit for the agent. Each returns the compact object its
  // caller acts on, clamped by the same rule as the cost tool: a tool result
  // that fills the window is worse than one that says it was truncated.
  bb.agents.registerTool({
    name: CONTEXT_TOOL.name,
    description: CONTEXT_TOOL.description,
    parameters: z
      .object({
        threadId: z
          .string()
          .min(1)
          .optional()
          .describe("Report this thread's compaction estimate as well."),
        cwd: z.string().min(1).optional(),
      })
      .strict(),
    execute({ threadId, cwd }) {
      const deps = contextRpcDeps();
      const view = takeSnapshot(deps, cwd === undefined ? {} : { cwd });
      return clampToolResult({
        cwd: view.snapshot.cwd,
        totalEstTokens: view.snapshot.totalEstTokens,
        calibrationError: view.snapshot.calibrationError,
        composition: view.composition,
        duplicates: view.duplicates.slice(0, 5),
        deadSkills: view.dead.length,
        deadSkillNames: view.dead.slice(0, 10).map((skill) => skill.name),
        ...(threadId === undefined
          ? {}
          : { thread: contextThread(deps, threadId) }),
      });
    },
  });

  bb.agents.registerTool({
    name: AUDIT_PACK_TOOL.name,
    description: AUDIT_PACK_TOOL.description,
    parameters: z
      .object({
        threadId: z.string().min(1).optional(),
        runFolder: z.string().min(1).optional(),
        export: z
          .boolean()
          .optional()
          .describe(
            "Write audit.json, audit.md and COST.md into the run folder. Off by default: a read must not leave files behind.",
          ),
      })
      .strict(),
    execute(target) {
      const auditTarget: AuditTarget = {
        ...(target.threadId === undefined ? {} : { threadId: target.threadId }),
        ...(target.runFolder === undefined
          ? {}
          : { runFolder: target.runFolder }),
      };
      return auditPackToolResult(auditRpcDeps(), auditTarget, {
        write: target.export === true,
      });
    },
  });

  bb.agents.registerTool({
    name: FAILURES_TOOL.name,
    description: FAILURES_TOOL.description,
    parameters: z.object({ range: z.string().optional() }).strict(),
    execute({ range }) {
      const rows = failureRows(auditRpcDeps(), { range: parseRange(range) });
      return clampToolResult({
        range: parseRange(range),
        rows: rows.slice(0, 10).map((row) => ({
          signature: row.signature.slice(0, 80),
          count: row.count,
          lastSeen: row.lastSeen,
          threads: row.threads.length,
        })),
      });
    },
  });

  // ---- distillery module surface (phase 6) ---------------------------------
  // Kept in one block so a concurrent edit elsewhere in this file merges
  // cleanly. Everything below reaches distillery through
  // `src/distillery/index.ts`.
  bb.rpc.register(distilleryContract, createDistilleryRpcHandlers(bb, distillery));

  bb.agents.registerTool({
    name: DISTILL_STATUS_TOOL.name,
    description: DISTILL_STATUS_TOOL.description,
    parameters: z.object({}).strict(),
    execute: () => {
      const runtime = distillery.current;
      if (!runtime) {
        return {
          content: [
            { type: "text" as const, text: "distillery module is not running" },
          ],
        };
      }
      // Counts and signatures only. The previews are redacted, but they are
      // still raw failure evidence and an agent asking for status wants the
      // shape of the backlog rather than its contents.
      return {
        content: [
          { type: "text" as const, text: renderStatusTool(runtime.status()) },
        ],
      };
    },
  });
  // ---- end distillery module surface ---------------------------------------

  bb.cli.register({
    name: "observatory",
    summary:
      "Cost, cache, stall, context, audit, eval and distillery for bb agent runs",
    commands: [
      {
        name: "status",
        summary: "Module states, breaker counts, store counts, and settings.",
        usage: "bb observatory status",
      },
      {
        name: "doctor",
        summary:
          "Checks the database opens, the migrations applied, and each provider log root exists.",
        usage: "bb observatory doctor",
      },
      {
        name: "coverage",
        summary:
          "How many turns have a proven cache split, whole ledger and per provider.",
        usage: "bb observatory coverage [--provider <id>]",
      },
      {
        name: "index",
        summary:
          "Run log index passes now instead of waiting for the five-minute schedule.",
        usage: "bb observatory index [--budget-mb <N>] [--passes <N>]",
      },
      {
        name: "backfill",
        summary:
          "Drain thread history from --since, re-index the logs, and report coverage.",
        usage:
          "bb observatory backfill --since <ISO|Nd> [--provider <id>] [--reset]",
      },
      {
        name: "cost",
        summary:
          "Priced rollups by lineage, model or day, or one thread's per-turn split.",
        usage:
          "bb observatory cost [--range 7d] [--group lineage|model|day] [--tree <threadId>] [--run <folder>] [--json]",
      },
      {
        name: "cost-md",
        summary:
          "Write the retro seat's COST.md for a deliver run folder.",
        usage:
          "bb observatory cost-md <runFolder> [--snapshot final|mid-run] [--stdout]",
      },
      {
        name: "cache-misses",
        summary:
          "Turns whose cached prefix stopped being reused, with the correlate that explains it.",
        usage: "bb observatory cache-misses [--range 7d] [--thread <threadId>]",
      },
      ...WATCH_CLI_COMMANDS,
      {
        name: "context",
        summary:
          "What every request in a project pays for before the first word, with duplicates and dead skills.",
        usage:
          "bb observatory context [surfaces] [--cwd <path>] [--thread <threadId>] [--json]",
      },
      {
        name: "audit",
        summary:
          "One session's metrics against the 7-day median, its verification coverage and its unverified edits.",
        usage:
          "bb observatory audit [<threadId|runFolder>] [--range 7d] [--json] [--export] [--pack]",
      },
      {
        name: "failures",
        summary: "Failure signatures by count, with when each was last seen.",
        usage: "bb observatory failures [--range 7d] [--include-muted]",
      },
      {
        name: "insights",
        summary:
          "Cost drivers by seat, models by cost, and failure signatures by count.",
        usage: "bb observatory insights [--range 7d]",
      },
      // --- eval ---
      ...EVAL_CLI_COMMANDS,
      // --- end eval ---
      ...DISTILL_CLI_COMMANDS,
    ],
    async run(argv) {
      const [command] = argv;
      if (command === "watch") return runWatchCli(bb, watch, argv.slice(1));
      if (command === "distill") return runDistillCli(distillery, argv.slice(1));
      if (command === "status") {
        return {
          exitCode: 0,
          stdout: `${formatStatus(
            await status(),
            core.current?.ingest.counters() ?? null,
          )}\n`,
        };
      }
      if (
        command === "coverage" ||
        command === "backfill" ||
        command === "index"
      ) {
        const runtime = core.current;
        if (!runtime) {
          return { exitCode: 1, stderr: "core module is not running\n" };
        }
        if (command === "coverage") {
          const only = flagValue(argv, "provider") ?? null;
          return {
            exitCode: 0,
            stdout: `${formatCoverage(
              runtime.events.coverage(only),
              runtime.events.coverageByProvider(only),
            )}\n`,
          };
        }
        if (command === "index") {
          const values = await readSettings();
          return indexNow(runtime, argv.slice(1), values["index_budgetMb"]);
        }
        return backfill(bb, runtime, argv.slice(1));
      }
      // --- eval ---
      if (command === EVAL_COMMAND) {
        const runtime = evalHandle.current;
        if (!runtime) {
          return { exitCode: 1, stderr: "eval module is not running\n" };
        }
        return await runEvalCommand(
          runtime.deps,
          argv.slice(1),
          runtime.databasePath,
          runtime.live,
        );
      }
      // --- end eval ---
      if (SPEND_COMMANDS.includes(command as SpendCommand)) {
        return runSpendCommand(spendDeps, command as SpendCommand, argv.slice(1));
      }
      if (command === "context") {
        return runContextCommand(contextRpcDeps, argv.slice(1));
      }
      if (AUDIT_COMMANDS.includes(command as (typeof AUDIT_COMMANDS)[number])) {
        return runAuditCommand(
          auditRpcDeps,
          command as (typeof AUDIT_COMMANDS)[number],
          argv.slice(1),
        );
      }
      if (command === "doctor") {
        const values = await readSettings();
        const checks = runDoctor(store, parseRoots(values["roots_extra"]));
        // A missing provider root is a fact, not a failure: nobody runs all
        // five agents. Only the plugin's own storage can fail this command.
        const broken = checks.filter(
          (check) => !check.ok && !check.name.startsWith("root "),
        );
        return {
          exitCode: broken.length === 0 ? 0 : 1,
          stdout: `${formatDoctor(checks)}\n`,
        };
      }
      const helpRequested =
        command === undefined || command === "--help" || command === "-h";
      return helpRequested
        ? { exitCode: 0, stdout: `${USAGE}\n` }
        : { exitCode: 1, stderr: `${USAGE}\n` };
    },
  });

  bb.onDispose(() => {
    bb.log.info(`[${CORE_MODULE_ID}] disposed`);
  });
}
