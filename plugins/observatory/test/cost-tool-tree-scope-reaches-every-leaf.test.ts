// The tree scope has to answer "what did this run cost", which means the whole
// subtree.
//
// Lineage rows are not a flat parent/child list: a seat row with a synthetic
// key sits between a root and its threads, so `parentKey === id` matches the
// seat rows and stops there. Every leaf - the threads that hold the actual
// spend - fell out of the answer, and the tool reported a subtree total made
// of nothing.
import { describe, expect, it } from "vitest";
import { subtreeRows } from "../src/server.js";
import type { SpendRow } from "../src/spend/contract.js";

function row(
  key: string,
  depth: number,
  parentKey?: string,
): SpendRow {
  return {
    key,
    label: key,
    depth,
    ...(parentKey === undefined ? {} : { parentKey }),
    kind: depth === 1 ? "seat" : "thread",
    turns: 1,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    costUsd: 1,
    estimated: false,
  };
}

describe("subtreeRows", () => {
  it("includes a leaf thread reached through a synthetic seat row", () => {
    const rows = [
      row("root", 0),
      row("root:seat:deliver-implementer", 1, "root"),
      row("leaf", 2, "root:seat:deliver-implementer"),
      row("other", 0),
      row("other:seat:qa", 1, "other"),
    ];

    const keys = subtreeRows(rows, "root").map((entry) => entry.key);

    expect(keys).toContain("leaf");
    expect(keys).toEqual([
      "root",
      "root:seat:deliver-implementer",
      "leaf",
    ]);
  });

  it("returns just the row itself when the thread has no children", () => {
    const rows = [row("root", 0), row("solo", 0)];

    expect(subtreeRows(rows, "solo").map((entry) => entry.key)).toEqual(["solo"]);
  });
});
