import { describe, expect, it } from "vitest";
import { parseClaudeLines } from "../src/core/parsers/claude.js";
import { CLAUDE_SESSION, fixtureLines, fixturePath } from "./log-fixtures.js";

// Claude Code is the only provider on this machine that reports the split, so
// it is the one that lets a turn be classified `log-exact` downstream. If this
// ever regresses to a single cached total, every cache-miss signal and every
// savings figure quietly becomes a guess.
describe("the Claude parser", () => {
  it("reports cache read and cache write as separate measured numbers", () => {
    const rows = parseClaudeLines(fixtureLines(...CLAUDE_SESSION), {
      path: fixturePath(...CLAUDE_SESSION),
      startLine: 0,
    });

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.cacheRead).not.toBeNull();
      expect(row.cacheWrite).not.toBeNull();
    }

    const split = rows.find(
      (row) => (row.cacheRead ?? 0) > 0 && (row.cacheWrite ?? 0) > 0,
    );
    expect(split, "fixture must contain a turn with both read and write").toBeDefined();
    // The two are distinct measurements, not one number copied twice.
    expect(split!.cacheRead).not.toEqual(split!.cacheWrite);
    expect(split!.input).toBeGreaterThanOrEqual(0);
  });

  it("leaves the split null when the usage object omits it", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-01T00:00:00.000Z",
      sessionId: "s1",
      requestId: "req_1",
      message: { model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: 2 } },
    });

    const [row] = parseClaudeLines([line], { path: "/x/.claude/projects/a.jsonl", startLine: 0 });

    expect(row.cacheRead).toBeNull();
    expect(row.cacheWrite).toBeNull();
  });
});
