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
import { LocalHostClient } from "./core/host-client.js";
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
 * Phase 0 modules: each one registers and logs, so the registry, the breaker
 * and the enabled-check are exercised end to end before any module has work.
 */
export const MODULES: readonly ObservatoryModule[] = MODULE_IDS.map((id) =>
  defineModule({
    id,
    setup(ctx) {
      ctx.bb.log.info(`[${id}] registered`);
    },
  }),
);

const USAGE = [
  "Usage: bb observatory <command>",
  "",
  "  status   Module states, breaker counts, store counts, settings",
  "  doctor   Database, migrations, and provider log roots",
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

export function formatStatus(status: StatusView): string {
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
  return lines.join("\n");
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

  const registry = new ModuleRegistry({
    bb,
    db: () => db,
    settings: readSettings,
  });
  await registry.register(MODULES);

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
    ],
    async run(argv) {
      const [command] = argv;
      if (command === "status") {
        return { exitCode: 0, stdout: `${formatStatus(await status())}\n` };
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
