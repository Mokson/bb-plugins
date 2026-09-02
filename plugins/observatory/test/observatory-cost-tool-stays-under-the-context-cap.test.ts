// Two budgets, both charged to every session the tool is mounted in: the
// tool's own text, which bb caps at 4096 characters, and the result it
// returns, which nothing caps but a context window. A cost report grows with
// the length of a run, so an uncapped result is a slow leak into every agent
// that ever asks what a thread cost.
import { describe, expect, it } from "vitest";
import {
  COST_TOOL,
  TOOL_RESULT_LIMIT,
  clampToolResult,
} from "../src/server.js";

describe("observatory_cost", () => {
  it("keeps its description under 200 characters and its text under the cap", () => {
    expect(COST_TOOL.description.length).toBeLessThan(200);
    expect(
      (COST_TOOL.name + COST_TOOL.description).length,
    ).toBeLessThan(TOOL_RESULT_LIMIT);
    // The name is what the model types; it has to be the reserved-safe shape.
    expect(COST_TOOL.name).toMatch(/^[a-zA-Z0-9_-]+$/u);
  });

  it("returns a short payload unchanged", () => {
    const payload = { scope: "thread", turns: 4 };

    const result = clampToolResult(payload);

    expect(result).toBe(JSON.stringify(payload));
    expect(JSON.parse(result)).toEqual(payload);
  });

  it("caps an oversized payload and says so rather than truncating silently", () => {
    const result = clampToolResult({
      scope: "run",
      costMd: "x".repeat(TOOL_RESULT_LIMIT * 4),
    });

    expect(result.length).toBeLessThanOrEqual(TOOL_RESULT_LIMIT);
    // A model that got a clipped answer must be able to tell.
    expect(result.startsWith('{"truncated":true')).toBe(true);
  });

  it("caps a real row list at the same ceiling", () => {
    const rows = Array.from({ length: 500 }, (_, index) => ({
      key: `thread-${index}`,
      label: `[son5:low] deliver-implementer wave ${index}`,
      depth: 1,
      kind: "thread",
      turns: index,
      costUsd: index / 100,
    }));

    expect(clampToolResult({ scope: "tree", rows }).length).toBeLessThanOrEqual(
      TOOL_RESULT_LIMIT,
    );
  });
});
