import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { matchScore, rankSearch, type SearchCandidate } from "./search";

const BASE = new Date(2026, 7, 30, 12, 0, 0, 0).getTime();

/** B69: `sequence` is the entrance order — higher entered its section later. */
function candidate(id: string, title: string, sequence: number): SearchCandidate {
  return {
    thread: { id, latestAttentionAt: sequence } as PluginSidebarThread,
    title,
    projectName: "Acme",
    sequence,
  };
}

describe("matchScore", () => {
  it("ranks exact above prefix above word-start above mid-word", () => {
    expect(matchScore("deploy", "deploy")).toBe(4);
    expect(matchScore("deploy the thing", "deploy")).toBe(3);
    expect(matchScore("fix the deploy", "deploy")).toBe(2);
    expect(matchScore("redeploy", "deploy")).toBe(1);
  });

  it("is case-insensitive and trims the query", () => {
    expect(matchScore("Deploy", "  DEPLOY ")).toBe(4);
  });

  it("returns null for a miss and for a blank query", () => {
    expect(matchScore("deploy", "rollback")).toBeNull();
    expect(matchScore("deploy", "   ")).toBeNull();
  });
});

describe("rankSearch (B43)", () => {
  it("orders by score, then entrance order descending, then id (B69)", () => {
    const ranked = rankSearch(
      [
        candidate("c", "fix the deploy", BASE + 3),
        candidate("a", "deploy the thing", BASE + 1),
        candidate("b", "deploy the thing", BASE + 2),
        candidate("d", "unrelated", BASE + 9),
      ],
      "deploy",
    );
    expect(ranked.map((entry) => entry.thread.id)).toEqual(["b", "a", "c"]);
  });

  it("drops non-matching candidates entirely", () => {
    expect(rankSearch([candidate("a", "unrelated", BASE)], "deploy")).toHaveLength(0);
  });
});
