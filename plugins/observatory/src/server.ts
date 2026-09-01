// Observatory — backend entry.
//
// Phase 0 assembles the skeleton and nothing else: settings, the migrated
// store, the module registry with its per-module breaker, one status view
// served identically to the CLI and the panel, and a doctor that checks the
// provider log roots exist. Every module's `setup` is a stub; the modules
// themselves land in later phases behind these seams.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  BbPluginApi,
  PluginSettingDescriptor,
  PluginSettingDescriptors,
} from "@get-bb/plugin-sdk";
import { observatoryContract, type ModuleState, type StatusView } from "./contract.js";
import { ObservatoryStore, applyMigrations } from "./core/store.js";
import { EventStore, type CoverageView } from "./core/store-events.js";
import { createIngest, type Ingest, type IngestCounters } from "./core/ingest.js";
import type { LogTurnSource, PriceTurnFn } from "./core/join.js";
import { LocalHostClient } from "./core/host-client.js";
import { LogStore } from "./core/store-logs.js";
import { priceTurn } from "./core/pricing.js";
import { loadCatalog, type PricingCatalog } from "./core/catalog.js";
import {
  createLogIndexer,
  defaultLogRoots,
  type LogIndexer,
} from "./core/indexer.js";
import {
  CORE_MODULE_ID,
  ModuleRegistry,
  defineModule,
  moduleEnabledKvKey,
  moduleEnabledSettingKey,
  type ModuleId,
  type ObservatoryModule,
} from "./module.js";

export const PHASE = "phase 0 scaffold";

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
    /**
     * The port hands pricing a catalog it types as `unknown`. The loaded
     * catalog is read from this closure instead, so a refresh takes effect
     * without re-threading it through every caller.
     */
    const priceTurnPort: PriceTurnFn = (input) =>
      priceTurn(
        {
          provider: input.provider,
          model: input.model,
          inputTokens: input.inputTokens ?? 0,
          cacheReadTokens: input.cacheReadTokens,
          cacheWriteTokens: input.cacheWriteTokens,
          cachedInputTokens: input.cachedInputTokens ?? 0,
          outputTokens: input.outputTokens ?? 0,
          reasoningTokens: input.reasoningTokens ?? 0,
          loggedCostUsd: input.loggedCostUsd,
        },
        catalog,
      );
    const indexer = createLogIndexer({
      store,
      host: new LocalHostClient(),
      roots: [...options.roots],
      log: bb.log,
    });
    return {
      logs: toLogTurnSource(store),
      priceTurn: priceTurnPort,
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
      });
      handle.current = { store, events, ingest, indexer: stack?.indexer ?? null };

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
      bb.log.info(
        `[core] ingest registered over ${roots.length} log roots` +
          (stack ? "" : " (log stack absent)"),
      );
    },
  });
}

/**
 * Non-core modules are still stubs: they are read-only analyzers over the
 * ledger core writes, and they land in later phases behind these seams.
 */
export function buildModules(
  handle: CoreHandle,
  settings: () => Promise<Record<string, string | boolean | undefined>>,
): readonly ObservatoryModule[] {
  return MODULE_IDS.map((id) =>
    id === CORE_MODULE_ID
      ? createCoreModule(handle, settings)
      : defineModule({
          id,
          setup(ctx) {
            ctx.bb.log.info(`[${id}] registered`);
          },
        }),
  );
}

const USAGE = [
  "Usage: bb observatory <command>",
  "",
  "  status     Module states, breaker counts, store counts, settings",
  "  doctor     Database, migrations, and provider log roots",
  "  coverage   Turn split coverage: log-exact, log-window, sidechain, n/a",
  "  index      Run log index passes now: [--budget-mb N] [--passes N]",
  "  backfill   Drain history and re-join it: --since <ISO|Nd> [--provider p]",
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
        : typeof setting === "boolean"
          ? "setting"
          : "default";
    const enabled =
      !breaker.tripped &&
      (typeof override === "boolean" ? override : setting === true);
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
    phase: PHASE,
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
  const lines = [`observatory ${status.phase}`, "", "modules"];
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

export function formatCoverage(coverage: CoverageView): string {
  const share = (n: number) =>
    coverage.turns === 0 ? "  n/a" : `${((n / coverage.turns) * 100).toFixed(1)}%`;
  return [
    `turns          ${coverage.turns}`,
    `log-exact      ${coverage.logExact} (${share(coverage.logExact)})`,
    `log-window     ${coverage.logWindow} (${share(coverage.logWindow)})`,
    `sidechain      ${coverage.sidechain}`,
    `unavailable    ${coverage.unavailable} (${share(coverage.unavailable)})`,
  ].join("\n");
}

/** `--provider codex` style flags. Absent flag returns undefined. */
export function flagValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
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
  const threads = await bb.sdk.threads.list({ includeHidden: true, limit: 500 });
  const selected = threads.filter(
    (thread) =>
      thread.createdAt >= since &&
      (provider === undefined || thread.providerId === provider),
  );
  let drained = 0;
  for (const thread of selected) {
    runtime.ingest.markDirty(thread.id);
    drained += 1;
  }
  // Drain until the dirty set stops shrinking: a per-tick budget can requeue a
  // long thread, and a backfill must actually finish it.
  for (let pass = 0; pass < 100; pass += 1) {
    await runtime.ingest.drainOnce();
    if (runtime.ingest.counters().dirty === 0) break;
  }
  runtime.ingest.rejoinPending();
  return {
    exitCode: 0,
    stdout: `backfilled ${drained} threads since ${new Date(since).toISOString()}\n${formatCoverage(
      runtime.events.coverage(),
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

  // Phase 0 keeps the indexer in-process. The `bb.host` entry exists and
  // answers the same contract, so phase 1 swaps this for `bb.hosts.
  // experimental_client(...)` without touching a caller.
  const host = new LocalHostClient();
  void host;

  const core: CoreHandle = { current: null };
  const registry = new ModuleRegistry({
    bb,
    db: () => db,
    settings: readSettings,
  });
  await registry.register(buildModules(core, readSettings));

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
          "How many turns have a proven cache split, and how many stay unavailable.",
        usage: "bb observatory coverage",
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
        usage: "bb observatory backfill --since <ISO|Nd> [--provider <id>]",
      },
    ],
    async run(argv) {
      const [command] = argv;
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
          return {
            exitCode: 0,
            stdout: `${formatCoverage(runtime.events.coverage())}\n`,
          };
        }
        if (command === "index") {
          const values = await readSettings();
          return indexNow(runtime, argv.slice(1), values["index_budgetMb"]);
        }
        return backfill(bb, runtime, argv.slice(1));
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
