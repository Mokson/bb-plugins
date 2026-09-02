// `bb observatory distill` — the same objects the panel renders, as text.
//
// `--json` emits the RPC output verbatim so a script and the panel read one
// contract, the way `bb observatory watch` already does.
import { readFileSync } from "node:fs";
import type { PluginCliResult } from "@get-bb/plugin-sdk";
import type { DistilleryHandle } from "./queue.js";
import { requireRuntime } from "./rpc.js";
import { draftEditSchema, type DraftState } from "./contract.js";
import { DRAFT_STATES } from "./contract.js";

export const DISTILL_CLI_COMMANDS = [
  {
    name: "distill",
    summary:
      "Mine recurring delivery failures into reviewable harness fixes, and apply the ones you accept.",
    usage:
      "bb observatory distill scan [--run <folder>] | list [--state <s>] | show <id> | accept <id> | reject <id> | edit <id> --file <json> | apply <id> | draft",
  },
] as const;

const USAGE = DISTILL_CLI_COMMANDS[0].usage;

function json(value: unknown): PluginCliResult {
  return { exitCode: 0, stdout: `${JSON.stringify(value, null, 2)}\n` };
}

/**
 * Run the `distill` subtree. `argv` is everything AFTER `distill`, so the
 * top-level dispatcher stays a single line.
 */
export async function runDistillCli(
  handle: DistilleryHandle,
  argv: readonly string[],
): Promise<PluginCliResult> {
  const runtime = handle.current;
  if (!runtime) {
    return { exitCode: 1, stderr: "distillery module is not running\n" };
  }
  const wantsJson = argv.includes("--json");
  const [sub, ...rest] = argv;

  switch (sub) {
    case "scan": {
      const runIndex = rest.indexOf("--run");
      const runFolder = runIndex === -1 ? undefined : rest[runIndex + 1];
      const counts = requireRuntime(handle).scan(runFolder);
      if (wantsJson) return json(counts);
      const bySource = Object.entries(counts.bySource)
        .sort((a, b) => b[1] - a[1])
        .map(([source, n]) => `  ${String(n).padStart(5)}  ${source}`)
        .join("\n");
      return {
        exitCode: 0,
        stdout:
          `scanned ${counts.scanned} correction(s), stored ${counts.inserted} new\n` +
          `${bySource || "  none"}\n` +
          `clusters ${counts.clusters}, qualifying ${counts.qualifying}\n`,
      };
    }

    case "list": {
      const stateIndex = rest.indexOf("--state");
      const raw = stateIndex === -1 ? undefined : rest[stateIndex + 1];
      if (raw && !(DRAFT_STATES as readonly string[]).includes(raw)) {
        return {
          exitCode: 1,
          stderr: `unknown state "${raw}"; one of ${DRAFT_STATES.join(", ")}\n`,
        };
      }
      const rows = runtime.queue(raw as DraftState | undefined);
      if (wantsJson) return json({ rows });
      if (rows.length === 0) {
        return { exitCode: 0, stdout: "no drafts in the queue\n" };
      }
      const lines = rows.flatMap((row) => [
        `${row.draft.state.padEnd(8)} ${row.draft.id}  rung ${
          row.draft.rung ?? "-"
        }  recurrence ${row.draft.recurrence}`,
        `         ${row.cluster?.signature ?? "(cluster missing)"}`,
        `         home ${row.draft.homeFile ?? "-"}`,
      ]);
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    }

    case "show": {
      const id = rest[0];
      if (!id) {
        return { exitCode: 1, stderr: "usage: distill show <id>\n" };
      }
      const row = runtime.draft(id);
      if (!row) return { exitCode: 1, stderr: `no draft ${id}\n` };
      if (wantsJson) return json(row);
      const lines = [
        `draft ${row.draft.id}  ${row.draft.state}`,
        `cluster   ${row.cluster?.signature ?? "-"}`,
        `home      ${row.draft.homeFile ?? "-"}`,
        `rung      ${row.draft.rung ?? "-"}`,
        `recurrence ${row.draft.recurrence}`,
        "",
        "rule:",
        row.draft.ruleText ?? "  (none)",
        "",
        "patch:",
        row.draft.patchUnifiedDiff ?? "  (none)",
        "",
        `success signal: ${row.draft.successSignal ?? "-"}`,
        `rationale:      ${row.draft.rationale ?? "-"}`,
        "",
        "evidence:",
        ...row.evidence.map(
          (item) => `  [${item.source}] ${item.preview}`,
        ),
      ];
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    }

    case "accept":
    case "reject":
    case "apply": {
      const id = rest[0];
      if (!id) {
        return { exitCode: 1, stderr: `usage: distill ${sub} <id>\n` };
      }
      const result = runtime.act({ id, action: sub });
      if (wantsJson) return json(result);
      if (result.blocked) {
        // Exit 1: a blocked apply is a refusal a script must be able to detect
        // without parsing prose.
        return { exitCode: 1, stderr: `blocked: ${result.blocked}\n` };
      }
      return {
        exitCode: 0,
        stdout: result.writtenPath
          ? `${sub} ${id}: wrote ${result.writtenPath}\n`
          : `${sub} ${id}: ${result.draft.state}\n`,
      };
    }

    case "edit": {
      const id = rest[0];
      const fileIndex = rest.indexOf("--file");
      const file = fileIndex === -1 ? undefined : rest[fileIndex + 1];
      if (!id || !file) {
        return {
          exitCode: 1,
          stderr: "usage: distill edit <id> --file <json>\n",
        };
      }
      let edit: unknown;
      try {
        edit = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        return {
          exitCode: 1,
          stderr: `could not read ${file}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        };
      }
      const parsed = draftEditSchema.safeParse(edit);
      if (!parsed.success) {
        return {
          exitCode: 1,
          stderr: `${file} is not a valid edit: ${parsed.error.message}\n`,
        };
      }
      const result = runtime.act({ id, action: "edit", edit: parsed.data });
      return wantsJson
        ? json(result)
        : { exitCode: 0, stdout: `edited ${id}\n` };
    }

    case "draft": {
      const result = await runtime.draftBatch();
      if (wantsJson) return json(result);
      if (result.skipped) {
        return { exitCode: 0, stdout: `no batch spawned: ${result.skipped}\n` };
      }
      return {
        exitCode: 0,
        stdout: `spawned ${result.threadId} for ${result.clusters.length} cluster(s)\n`,
      };
    }

    default:
      return sub === undefined || sub === "--help"
        ? { exitCode: 0, stdout: `${USAGE}\n` }
        : { exitCode: 1, stderr: `unknown distill command "${sub}"\n${USAGE}\n` };
  }
}
