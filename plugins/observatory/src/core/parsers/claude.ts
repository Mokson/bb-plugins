// Claude Code session logs (`~/.claude/projects/**/*.jsonl`).
//
// The only provider on this machine that reports the cache split directly, so
// it is the one that produces `log-exact` matches downstream. Two facts about
// the format drive everything here, both verified against real files:
//
//  1. One request writes SEVERAL assistant rows as the response streams, all
//     carrying the SAME `requestId` and the SAME (final, cumulative) `usage`.
//     Summing them multiplies the bill. They are deduped by `requestId`.
//  2. Skill and MCP attribution is a first-class row field
//     (`attributionSkill`, `attributionMcpServer`), not something to be
//     reconstructed from tool_use blocks. The blocks are still read, because
//     the attribution fields describe what the row was FOR while a `Skill`
//     tool_use records a skill being loaded in this turn.
import {
  asArray,
  asObject,
  count,
  countOrNull,
  distinct,
  epochMs,
  jsonLines,
  text,
  type LogParser,
  type ParseContext,
  type ParsedLogTurn,
} from "./types.js";

export const CLAUDE_PROVIDER = "claude-code";

/** `<synthetic>` rows are local placeholders, never billed. */
const SYNTHETIC_MODEL = "<synthetic>";

function toolUses(message: Record<string, unknown>) {
  return asArray(message.content)
    .map(asObject)
    .filter(
      (block): block is Record<string, unknown> =>
        block !== null && block.type === "tool_use",
    );
}

export function parseClaudeLines(
  lines: string[],
  ctx: ParseContext,
): ParsedLogTurn[] {
  const rows: ParsedLogTurn[] = [];
  for (const { value, line } of jsonLines(lines, ctx.startLine)) {
    if (value.type !== "assistant") continue;
    const message = asObject(value.message);
    const usage = asObject(message?.usage);
    const ts = epochMs(value.timestamp);
    if (!message || !usage || ts === null) continue;

    const model = text(message.model);
    const input = count(usage.input_tokens);
    const cacheRead = countOrNull(usage.cache_read_input_tokens);
    const cacheWrite = countOrNull(usage.cache_creation_input_tokens);
    const output = count(usage.output_tokens);
    // A synthetic row with no tokens is a UI placeholder, not a model call.
    if (
      model === SYNTHETIC_MODEL &&
      input + (cacheRead ?? 0) + (cacheWrite ?? 0) + output === 0
    ) {
      continue;
    }

    const blocks = toolUses(message);
    const skillNames = distinct([
      text(value.attributionSkill),
      ...blocks
        .filter((block) => block.name === "Skill")
        .map((block) => text(asObject(block.input)?.skill)),
    ]);
    const mcpNames = distinct([
      text(value.attributionMcpServer),
      ...blocks
        .map((block) => text(block.name))
        .filter((name): name is string => name !== null && name.startsWith("mcp__")),
    ]);

    rows.push({
      provider: CLAUDE_PROVIDER,
      providerThreadId: text(value.sessionId),
      ts,
      line,
      // The stream-flush dedupe. Falls back to the message id, then to the
      // indexer's ts-and-line key, so a row without a request identity is
      // still stored rather than dropped.
      dedupeKey: text(value.requestId) ?? text(message.id),
      model,
      input,
      cacheRead,
      cacheWrite,
      output,
      reasoning: count(asObject(usage.output_tokens_details)?.thinking_tokens),
      // Claude Code never writes a cost.
      loggedCostUsd: null,
      isSidechain: value.isSidechain === true,
      agentId: text(value.agentId),
      cwd: text(value.cwd),
      skillNames,
      mcpNames,
    });
  }
  return rows;
}

export const claudeParser: LogParser = {
  provider: CLAUDE_PROVIDER,
  matches: (path) => path.endsWith(".jsonl") && path.includes("/.claude/projects/"),
  parseLines: parseClaudeLines,
};
