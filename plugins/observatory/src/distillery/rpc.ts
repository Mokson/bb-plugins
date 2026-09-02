// The distillery RPC handlers, and the agent tool's text.
//
// Every handler refuses rather than serving an empty page as a real one: a
// queue that renders "0 pending" because the module is off is indistinguishable
// from a queue that is genuinely empty, and the difference is the whole point
// of looking.
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { DistilleryHandle, DistilleryRuntime } from "./queue.js";
import { distilleryContract, type DistillStatus } from "./contract.js";

export function requireRuntime(handle: DistilleryHandle): DistilleryRuntime {
  const runtime = handle.current;
  if (!runtime) throw new Error("distillery module is not running");
  return runtime;
}

export function createDistilleryRpcHandlers(
  _bb: BbPluginApi,
  handle: DistilleryHandle,
): PluginRpcHandlers<typeof distilleryContract> {
  return {
    "observatory_distill_status": () => requireRuntime(handle).status(),
    "observatory_distill_queue": ({ state, limit }) => ({
      rows: requireRuntime(handle).queue(state, limit ?? 50),
    }),
    "observatory_distill_draft": ({ id }) => {
      const row = requireRuntime(handle).draft(id);
      if (!row) throw new Error(`no draft ${id}`);
      return row;
    },
    "observatory_distill_act": (input) => {
      const result = requireRuntime(handle).act(
        input as Parameters<DistilleryRuntime["act"]>[0],
      );
      return {
        draft: result.draft,
        blocked: result.blocked,
        writtenPath: result.writtenPath,
      };
    },
    "observatory_distill_scan": ({ runFolder }) =>
      requireRuntime(handle).scan(runFolder),
    "observatory_distill_draft_batch": async () =>
      requireRuntime(handle).draftBatch(),
  };
}

/**
 * The cap bb applies to a tool's own text, reused as the ceiling on this
 * tool's RESULT. `distillery_status` is deliberately counts-and-signatures
 * only: previews are redacted but they are still the raw evidence, and an
 * agent asking "what is the distillery holding" needs the shape of the
 * backlog, not its contents.
 */
export const STATUS_TOOL_MAX_CHARS = 4096;

export const STATUS_TOOL = {
  name: "distillery_status",
  description:
    "Counts and top clusters from the observatory distillery: how many " +
    "recurring delivery failures are queued as draft harness fixes, and " +
    "which signatures recur most. Signatures and counts only, no evidence " +
    "text. Read this before proposing a harness fix a draft already covers.",
} as const;

/** Render the status view for an agent, guaranteed under the cap. */
export function renderStatusTool(status: DistillStatus): string {
  const lines = [
    `drafts: ${status.pending} pending, ${status.accepted} accepted, ` +
      `${status.applied} applied, ${status.rejected} rejected`,
    `clusters: ${status.clusters}`,
    `drafting spend this month: $${status.monthSpendUsd.toFixed(2)} of ` +
      `$${status.budgetUsd.toFixed(2)}`,
    "",
    "top clusters:",
  ];
  if (status.topClusters.length === 0) lines.push("  none");
  for (const cluster of status.topClusters) {
    lines.push(
      `  ${cluster.size}x across ${cluster.runs} runs  ` +
        `[${cluster.cause_class ?? "untagged"}] ${cluster.signature}`,
    );
  }
  const text = lines.join("\n");
  // Truncating is better than a tool result bb rejects wholesale: the counts
  // are the first three lines and survive any cut.
  return text.length <= STATUS_TOOL_MAX_CHARS
    ? text
    : `${text.slice(0, STATUS_TOOL_MAX_CHARS - 3)}...`;
}
