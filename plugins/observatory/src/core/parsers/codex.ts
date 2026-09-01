// Codex sessions (`~/.codex/sessions` and `~/.codex/archived_sessions`).
//
// Codex reports `input_tokens` INCLUDING the cached portion and gives
// `cached_input_tokens` alongside it, so uncached input is the DIFFERENCE, not
// the reported figure. On a real rollout the cached share runs above 98%, so
// reading `input_tokens` straight through would inflate the priced input by
// roughly fifty times.
//
// `cache_write_input_tokens` is read when present and left null when absent.
// Defaulting it to 0 would let a downstream `cache_read + cache_write ==
// cachedInputTokens` check declare `log-exact` on a number nobody measured.
//
// Two fields are not where they look. The session id is only on `session_meta`,
// whose `model` is null in every real rollout; the concrete model only ever
// appears on `turn_context`, and it can change mid-session.
import {
  asObject,
  count,
  countOrNull,
  epochMs,
  jsonLines,
  text,
  type LogParser,
  type ParseContext,
  type ParsedLogTurn,
} from "./types.js";

export const CODEX_PROVIDER = "codex";

export function parseCodexLines(
  lines: string[],
  ctx: ParseContext,
): ParsedLogTurn[] {
  const rows: ParsedLogTurn[] = [];
  // Header state. `session_meta` and `turn_context` normally sit at the top of
  // the file, so on an incremental resume they are already behind the cursor;
  // the indexer compensates by keeping the file's `provider_thread_id` and
  // re-supplying it, and a null here is corrected at store time.
  let sessionId: string | null = null;
  let model: string | null = null;
  let cwd: string | null = null;

  for (const { value, line } of jsonLines(lines, ctx.startLine)) {
    const payload = asObject(value.payload);
    if (
      payload &&
      (value.type === "session_meta" || value.type === "turn_context")
    ) {
      model = text(payload.model) ?? model;
      cwd = text(payload.cwd) ?? cwd;
      if (value.type === "session_meta") {
        sessionId = text(payload.id) ?? sessionId;
      }
      continue;
    }
    if (value.type !== "event_msg" || payload?.type !== "token_count") continue;

    const usage = asObject(asObject(payload.info)?.last_token_usage);
    const ts = epochMs(value.timestamp);
    if (!usage || ts === null) continue;

    const totalInput = count(usage.input_tokens);
    // Clamped: a cached count above the total would make uncached negative.
    const cachedInput = Math.min(totalInput, count(usage.cached_input_tokens));

    rows.push({
      provider: CODEX_PROVIDER,
      providerThreadId: sessionId,
      ts,
      line,
      dedupeKey: null,
      model,
      input: totalInput - cachedInput,
      cacheRead: cachedInput,
      cacheWrite: countOrNull(usage.cache_write_input_tokens),
      output: count(usage.output_tokens),
      reasoning: count(usage.reasoning_output_tokens),
      loggedCostUsd: null,
      isSidechain: false,
      agentId: null,
      cwd,
      skillNames: [],
      mcpNames: [],
    });
  }
  return rows;
}

export const codexParser: LogParser = {
  provider: CODEX_PROVIDER,
  matches: (path) =>
    path.endsWith(".jsonl") &&
    (path.includes("/.codex/sessions/") ||
      path.includes("/.codex/archived_sessions/")),
  parseLines: parseCodexLines,
};
