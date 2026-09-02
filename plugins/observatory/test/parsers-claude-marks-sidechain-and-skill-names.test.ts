import { describe, expect, it } from "vitest";
import { parseClaudeLines } from "../src/core/parsers/claude.js";
import { CLAUDE_SIDECHAIN, fixtureLines, fixturePath } from "./log-fixtures.js";

// A deliver seat run as an in-session subagent is invisible to bb: it exists
// only as `isSidechain` rows under an `agentId`. Losing either field means the
// seat's spend lands on its parent as an unexplained lump.
describe("the Claude parser", () => {
  it("marks sidechain rows and carries the subagent's id and skill", () => {
    const rows = parseClaudeLines(fixtureLines(...CLAUDE_SIDECHAIN), {
      path: fixturePath(...CLAUDE_SIDECHAIN),
      startLine: 0,
    });

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.isSidechain)).toBe(true);
    expect(rows.every((row) => row.agentId !== null)).toBe(true);
    // The sidechain's session id is the PARENT's, which is what lets the join
    // attach these rows to the thread that spawned them.
    expect(rows[0].providerThreadId).toBeTruthy();
    expect(rows.some((row) => row.skillNames.length > 0)).toBe(true);
  });

  it("records a Skill tool use and an MCP tool as names, never as content", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-09-01T00:00:00.000Z",
      sessionId: "s1",
      requestId: "req_1",
      attributionSkill: "deliver",
      message: {
        model: "claude-opus-5",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: "tool_use", name: "Skill", input: { skill: "qa", args: "secret prose" } },
          { type: "tool_use", name: "mcp__linear__create_issue", input: { title: "secret" } },
          { type: "text", text: "secret prose" },
        ],
      },
    });

    const [row] = parseClaudeLines([line], { path: "/x/.claude/projects/a.jsonl", startLine: 0 });

    expect(row.skillNames).toEqual(["deliver", "qa"]);
    expect(row.mcpNames).toEqual(["mcp__linear__create_issue"]);
    expect(JSON.stringify(row)).not.toContain("secret prose");
  });
});
