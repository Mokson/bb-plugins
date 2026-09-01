import { describe, expect, it } from "vitest";
import { parseCodexLines } from "../src/core/parsers/codex.js";
import { CODEX_SESSION, fixtureLines, fixturePath } from "./log-fixtures.js";

// Codex reports `input_tokens` INCLUDING the cached portion, unlike every
// other provider here. Reading it as uncached input would double-count the
// cache read on every turn, and on this fixture the cached share is 99%.
describe("the Codex parser", () => {
  const rows = parseCodexLines(fixtureLines(...CODEX_SESSION), {
    path: fixturePath(...CODEX_SESSION),
    startLine: 0,
  });

  it("emits one row per `token_count` event", () => {
    expect(rows).toHaveLength(6);
  });

  it("subtracts the cached portion out of the reported input", () => {
    // Real numbers from the fixture: 141707 reported, 139008 of it cached.
    expect(rows[0].cacheRead).toBe(139_008);
    expect(rows[0].input).toBe(141_707 - 139_008);
    expect(rows.every((row) => row.input >= 0)).toBe(true);
  });

  it("reads output and reasoning as separate counts", () => {
    expect(rows[0].output).toBe(3_842);
    expect(rows[0].reasoning).toBe(3_636);
  });

  it("takes the cache write Codex actually reports, rather than assuming one", () => {
    expect(rows.every((row) => row.cacheWrite === 0)).toBe(true);
  });

  it("takes the session id from `session_meta` and the model from `turn_context`", () => {
    // `session_meta.payload.model` is null in real rollouts; the concrete
    // model only ever appears on the turn context.
    expect(rows[0].providerThreadId).toBe("01a04c3e-bf33-7eb2-a447-a5efeef76eda");
    expect(rows.every((row) => row.model === "gpt-5.6-sol")).toBe(true);
  });

  it("never reports a logged cost, because Codex does not write one", () => {
    expect(rows.every((row) => row.loggedCostUsd === null)).toBe(true);
  });
});
