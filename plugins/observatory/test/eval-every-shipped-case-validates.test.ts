// The five smoke cases ship OUTSIDE this repo, under ~/.agents/eval/cases,
// because the skill stack they measure lives there too. That makes them easy
// to break silently, which is exactly why they are loaded here.
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { expandHome, loadCasesDir } from "../src/eval/cases.js";

const CASES_DIR = "~/.agents/eval/cases";
const SHIPPED = [
  "bug-route-smoke",
  "gc-dry",
  "normal-small-feature",
  "qa-plan",
  "review-only",
];

describe("every shipped case validates", () => {
  const dir = expandHome(CASES_DIR);
  const present = existsSync(dir);

  it.runIf(present)("loads all five, with no errors", () => {
    const cases = loadCasesDir(CASES_DIR);
    const failures = cases
      .filter((entry) => entry.value === null)
      .map((entry) => `${entry.name}: ${entry.error}`);
    expect(failures).toEqual([]);
    expect(cases.map((entry) => entry.name).sort()).toEqual(SHIPPED);
  });

  it.runIf(present)("tags every case `smoke`, so --tag smoke selects the suite", () => {
    const cases = loadCasesDir(CASES_DIR);
    for (const entry of cases) expect(entry.tags).toContain("smoke");
  });

  it.runIf(present)("never lets a case reach a real tracker", () => {
    for (const entry of loadCasesDir(CASES_DIR)) {
      expect(entry.value?.harness.tracker).toBe("none");
    }
  });

  it.skipIf(present)("skips when ~/.agents/eval/cases is absent", () => {
    expect(loadCasesDir(CASES_DIR)).toEqual([]);
  });
});
