// The Pi log family: Pi's own sessions, and bb's pi-bridge sessions.
//
// Both write `{type:"message", timestamp, message:{role, provider, model,
// usage:{input, output, cacheRead, cacheWrite, reasoning, cost}}}`, so one
// parser covers them and `omp.ts` reuses it for a third root.
//
// The session id comes from the FILE PATH, not from the `{type:"session"}`
// header line. That header is line 0, and the indexer resumes mid-file: a
// parser that only learned the id from line 0 would emit null-session rows for
// every incremental pass after the first. Both layouts encode the id in the
// name, so the path is the reliable source.
import { basename } from "node:path";
import {
  asObject,
  count,
  countOrNull,
  epochMs,
  finite,
  jsonLines,
  text,
  type LogParser,
  type ParseContext,
  type ParsedLogTurn,
} from "./types.js";

export const PI_PROVIDER = "pi";
export const PI_BRIDGE_PROVIDER = "bb-pi-bridge";

/** A Pi session file name: an ISO-ish stamp, an underscore, then the id. */
const STAMPED_NAME = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_(.+)$/;

/**
 * `2026-08-16T12-30-26-142Z_01a00a8d-....jsonl` -> the id after the stamp.
 *
 * Only a LEADING timestamp is stripped. Splitting on the first underscore
 * instead would turn bb's `thr_2dpba3tjy8.jsonl` into `2dpba3tjy8`, and every
 * bridge row would then be attributed to a thread id that does not exist.
 */
export function sessionIdFromPath(path: string): string | null {
  const stem = basename(path).replace(/\.jsonl$/i, "");
  if (!stem) return null;
  return STAMPED_NAME.exec(stem)?.[1] ?? stem;
}

export function parsePiFamilyLines(
  provider: string,
  lines: string[],
  ctx: ParseContext,
): ParsedLogTurn[] {
  const providerThreadId = sessionIdFromPath(ctx.path);
  const rows: ParsedLogTurn[] = [];
  for (const { value, line } of jsonLines(lines, ctx.startLine)) {
    if (value.type !== "message") continue;
    const message = asObject(value.message);
    if (!message || message.role !== "assistant") continue;
    const usage = asObject(message.usage);
    const ts = epochMs(value.timestamp ?? message.timestamp);
    if (!usage || ts === null) continue;

    const cost = asObject(usage.cost);
    // Pi reports zero cost for locally-hosted and included-plan models. That
    // is a real zero, not a missing figure, so it is kept as 0 rather than
    // dropped to null and re-estimated from a catalog that would invent a bill.
    const loggedCostUsd = finite(cost?.total);

    rows.push({
      provider,
      providerThreadId,
      ts,
      line,
      dedupeKey: text(value.id),
      model: text(message.responseModel) ?? text(message.model),
      input: count(usage.input),
      cacheRead: countOrNull(usage.cacheRead),
      cacheWrite: countOrNull(usage.cacheWrite),
      output: count(usage.output),
      reasoning: count(usage.reasoning),
      loggedCostUsd,
      isSidechain: false,
      agentId: null,
      cwd: text(value.cwd) ?? text(asObject(value.session)?.cwd),
      // Pi's log carries no skill or MCP attribution.
      skillNames: [],
      mcpNames: [],
    });
  }
  return rows;
}

export const piParser: LogParser = {
  provider: PI_PROVIDER,
  matches: (path) =>
    path.endsWith(".jsonl") && path.includes("/.pi/agent/sessions/"),
  parseLines: (lines, ctx) => parsePiFamilyLines(PI_PROVIDER, lines, ctx),
};

export const piBridgeParser: LogParser = {
  provider: PI_BRIDGE_PROVIDER,
  matches: (path) =>
    path.endsWith(".jsonl") && path.includes("/.bb/pi-bridge-sessions/"),
  parseLines: (lines, ctx) => parsePiFamilyLines(PI_BRIDGE_PROVIDER, lines, ctx),
};
