// `bb observatory watch` — the same objects the panel renders, as text.
//
// `--json` emits the RPC output verbatim so a script and the panel read one
// contract, and `--follow` is deliberately absent from the render path: it
// only changes how often the same renderer runs.
import type { BbPluginApi, PluginCliResult } from "@get-bb/plugin-sdk";
import type { WatchMode, WatchRow } from "./contract.js";
import { WATCH_MODES } from "./contract.js";
import type { WatchHandle } from "./module.js";
import { buildExplain, buildWatchList } from "./views.js";
import { MODE_KV_KEY } from "./settings.js";
import { runManualSteer, settingsView } from "./rpc.js";

export const WATCH_CLI_COMMANDS = [
  {
    name: "watch",
    summary:
      "Active threads with their stall state, the rule that fired, and the evidence.",
    usage:
      "bb observatory watch [--follow] [--json] | watch explain <threadId> | watch steer|escalate <threadId> [--note <text>] | watch off|observe|steer",
  },
] as const;

/** `--note "..."`, the one flag the manual steers take. */
function noteFlag(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--note");
  return index === -1 ? undefined : argv[index + 1];
}

function duration(ms: number): string {
  if (ms < 1_000) return "0s";
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatWatchList(view: {
  watched: number;
  rows: WatchRow[];
}): string {
  if (view.rows.length === 0) return "no active threads";
  const lines = [`watching ${view.watched} active thread(s)`, ""];
  for (const row of view.rows) {
    const head = row.state === "stalled" ? "STALL" : "  ok ";
    const inflight = row.inflight
      ? `${row.inflight.kind}:${row.inflight.name}`
      : "-";
    lines.push(
      `${head} ${row.threadId}  ${duration(row.silentMs)} silent  ${inflight}`,
    );
    lines.push(
      `      ${row.title}${row.stage ? `  [${row.stage}]` : ""}`,
    );
    if (row.rule) lines.push(`      ${row.rule}: ${row.diagnostic ?? ""}`);
  }
  return lines.join("\n");
}

export function formatExplain(
  view: ReturnType<typeof buildExplain>,
): string {
  const lines = [`thread ${view.threadId}`, "", "signals:"];
  if (view.signals.length === 0) lines.push("  none");
  for (const signal of view.signals) {
    const state = signal.closedAt ? `closed ${signal.closedAt}` : "OPEN";
    lines.push(
      `  [${signal.severity}] ${signal.kind}  ${signal.openedAt}  ${state}`,
    );
    lines.push(`      ${signal.evidence}`);
  }
  lines.push("", "actions:");
  if (view.actions.length === 0) lines.push("  none");
  for (const action of view.actions) {
    lines.push(`  ${action.at}  ${action.action}  ${action.detail ?? ""}`);
  }
  return lines.join("\n");
}

/**
 * Run the `watch` subtree. `argv` is everything AFTER `watch`, so the
 * top-level dispatcher stays a single line.
 */
export async function runWatchCli(
  bb: BbPluginApi,
  handle: WatchHandle,
  argv: readonly string[],
  now: () => number = Date.now,
): Promise<PluginCliResult> {
  const runtime = handle.current;
  if (!runtime) {
    return { exitCode: 1, stderr: "watch module is not running\n" };
  }
  const json = argv.includes("--json");
  const [sub] = argv;

  if (sub === "explain") {
    const threadId = argv[1];
    if (!threadId) {
      return {
        exitCode: 1,
        stderr: "usage: bb observatory watch explain <threadId>\n",
      };
    }
    const view = buildExplain(runtime.queries, threadId);
    return {
      exitCode: 0,
      stdout: json
        ? `${JSON.stringify(view, null, 2)}\n`
        : `${formatExplain(view)}\n`,
    };
  }

  // `watch steer <threadId>` steers one thread; bare `watch steer` sets the
  // mode. The two spellings collide by design — a person types the word they
  // mean — so the argument decides, and this branch has to come FIRST or the
  // mode setter would swallow the steer.
  if (sub === "steer" || sub === "escalate") {
    const threadId = argv[1];
    if (threadId !== undefined && !threadId.startsWith("--")) {
      const result = await runManualSteer(
        runtime,
        sub,
        threadId,
        noteFlag(argv),
        "cli",
        now,
      );
      return {
        exitCode: result.sent ? 0 : 1,
        ...(result.sent
          ? {
              stdout: json
                ? `${JSON.stringify(result, null, 2)}\n`
                : `${result.message}\n`,
            }
          : // A refusal is a non-zero exit on stderr: a script that pipes this
            // into a loop must not read "watch mode is observe" as a steer.
            { stderr: `${result.message}\n` }),
      };
    }
  }

  if (sub && (WATCH_MODES as readonly string[]).includes(sub)) {
    // KV, not the setting: the mode must apply without a plugin reload, and
    // the CLI is the surface someone reaches for mid-incident.
    await bb.storage.kv.set(MODE_KV_KEY, sub as WatchMode);
    await runtime.refresh();
    const view = settingsView(runtime);
    return {
      exitCode: 0,
      stdout: json
        ? `${JSON.stringify(view, null, 2)}\n`
        : `watch mode ${view.mode}${view.note ? ` (${view.note})` : ""}\n`,
    };
  }

  if (sub !== undefined && sub !== "--json" && sub !== "--follow") {
    return {
      exitCode: 1,
      stderr: `unknown watch command "${sub}"\n${WATCH_CLI_COMMANDS[0].usage}\n`,
    };
  }

  const view = buildWatchList(runtime.queries, now());
  if (json) {
    return { exitCode: 0, stdout: `${JSON.stringify(view, null, 2)}\n` };
  }
  // A plugin CLI command returns one result; it cannot hold a stream open. So
  // `--follow` renders a snapshot and points at the surfaces that do push,
  // rather than pretending to tail and exiting immediately.
  const follow = argv.includes("--follow")
    ? "\n(--follow: the CLI renders one snapshot; the panel and the " +
      "observatory/signal realtime channel are the live surfaces)"
    : "";
  return { exitCode: 0, stdout: `${formatWatchList(view)}${follow}\n` };
}
