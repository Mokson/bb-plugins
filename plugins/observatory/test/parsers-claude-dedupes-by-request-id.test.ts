import { describe, expect, it } from "vitest";
import { parseClaudeLines } from "../src/core/parsers/claude.js";
import { logKeyFor } from "../src/core/host-client.js";
import { CLAUDE_SESSION, fixtureLines, fixturePath } from "./log-fixtures.js";

// One request writes several assistant rows as the response streams, each
// carrying the SAME cumulative usage. The store collapses them because the log
// key is derived from `requestId`; without that the bill is multiplied by
// however many times the stream happened to flush.
describe("Claude stream-flush duplicates", () => {
  it("collapse onto one log key per request id", () => {
    const lines = fixtureLines(...CLAUDE_SESSION);
    const rows = parseClaudeLines(lines, {
      path: fixturePath(...CLAUDE_SESSION),
      startLine: 0,
    });

    const requestIds = new Set(rows.map((row) => row.dedupeKey));
    // The fixture is real: it genuinely contains more rows than requests.
    expect(rows.length).toBeGreaterThan(requestIds.size);

    const keys = new Set(rows.map(logKeyFor));
    expect(keys.size).toBe(requestIds.size);
  });

  it("keep separate keys when there is no request id to dedupe on", () => {
    const row = (line: number) => ({
      provider: "claude-code",
      providerThreadId: "s1",
      ts: 1_756_000_000_000,
      line,
      dedupeKey: null,
      model: null,
      input: 0,
      cacheRead: null,
      cacheWrite: null,
      output: 0,
      reasoning: 0,
      loggedCostUsd: null,
      isSidechain: false,
      agentId: null,
      cwd: null,
      skillNames: [],
      mcpNames: [],
    });

    expect(logKeyFor(row(1))).not.toBe(logKeyFor(row(2)));
  });
});
