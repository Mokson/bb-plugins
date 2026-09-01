import { expect, test } from "vitest";
import {
  DUPLICATE_THRESHOLD,
  findDuplicates,
  overlapRatio,
  shingles,
} from "../src/context/duplicates.js";

const RULE =
  "never delete a file the user did not ask you to delete and always say why a change was made";
const REWORDED = `${RULE} in the pull request body as well`;
const OTHER =
  "prefer the smallest change that satisfies the plan and keep unrelated files untouched";

test("overlap is the same whichever block is asked first", () => {
  const a = shingles(RULE);
  const b = shingles(REWORDED);

  expect(overlapRatio(a, b)).toBe(overlapRatio(b, a));
  expect(overlapRatio(a, b)).toBeGreaterThan(DUPLICATE_THRESHOLD);
});

test("a block is never reported as a duplicate of itself", () => {
  const pairs = findDuplicates([
    { name: "CLAUDE.md", text: RULE, estTokens: 30 },
  ]);

  expect(pairs).toEqual([]);
});

test("each overlapping pair is reported once, with what deleting it recovers", () => {
  const pairs = findDuplicates([
    { name: "CLAUDE.md", text: RULE, estTokens: 30 },
    { name: "skill:pr", text: REWORDED, estTokens: 40 },
    { name: "AGENTS.md", text: OTHER, estTokens: 25 },
  ]);

  expect(pairs).toHaveLength(1);
  expect([pairs[0]?.a, pairs[0]?.b].sort()).toEqual(["CLAUDE.md", "skill:pr"]);
  // Only the smaller side can actually be deleted, so only it is offered.
  expect(pairs[0]?.recoverableTokens).toBeLessThanOrEqual(30);
  expect(pairs[0]?.recoverableTokens).toBeGreaterThan(0);
});
