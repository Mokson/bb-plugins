// A truncated tool result is still a tool result: the model has to parse it.
//
// The failure this pins is quiet. `JSON.stringify` of a sliced body is LONGER
// than the body, because every quote, backslash and control character in it
// grows; a room figure computed from the unescaped length therefore overshoots
// the cap, and the final slice back to the cap cuts the closing brace off. The
// model then gets a string that looks like JSON, is not, and reports the tool
// as broken rather than the answer as clipped.
import { describe, expect, it } from "vitest";
import { TOOL_RESULT_LIMIT, clampToolResult } from "../src/server.js";

describe("clampToolResult", () => {
  it("returns parseable JSON for a run scope with a 20k-character body", () => {
    // Quotes and newlines are what a real COST.md is full of, and they are
    // exactly what makes the serialized form outgrow the body.
    const costMd = '| agent | "model" |\n'.repeat(1_000);
    expect(costMd.length).toBeGreaterThanOrEqual(20_000);

    const result = clampToolResult({
      scope: "run",
      id: "/runs/OBS-1_observatory",
      agents: [],
      snapshot: "final",
      costMd,
    });

    expect(result.length).toBeLessThanOrEqual(TOOL_RESULT_LIMIT);
    const parsed = JSON.parse(result) as { truncated?: boolean; body?: string };
    expect(parsed.truncated).toBe(true);
    expect(typeof parsed.body).toBe("string");
  });

  it("stays parseable when the body is nothing but escapes", () => {
    const result = clampToolResult({ scope: "run", costMd: '\\"'.repeat(9_000) });

    expect(result.length).toBeLessThanOrEqual(TOOL_RESULT_LIMIT);
    expect((JSON.parse(result) as { truncated: boolean }).truncated).toBe(true);
  });
});
