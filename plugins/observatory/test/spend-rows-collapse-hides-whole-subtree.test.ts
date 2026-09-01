import { describe, expect, it } from "vitest";
import { parentKeys, toggleKey, visibleRows } from "../src/app/lib/rows.js";
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
    kind: "thread",
    turns: 1,
    inputTokens: 1,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: 1,
    costUsd: null,
    estimated: false,
  };
}

// root
//   a
//     a1
//     a2
//   b
// other
const TREE: SpendRow[] = [
  row("root", 0),
  row("a", 1, "root"),
  row("a1", 2, "a"),
  row("a2", 2, "a"),
  row("b", 1, "root"),
  row("other", 0),
];

describe("row tree building", () => {
  it("derives parents from parentKey, not from childCount", () => {
    expect([...parentKeys(TREE)]).toEqual(["root", "a"]);
  });

  it("shows every row when nothing is collapsed", () => {
    const visible = visibleRows(TREE, new Set());
    expect(visible.map((entry) => entry.row.key)).toEqual([
      "root",
      "a",
      "a1",
      "a2",
      "b",
      "other",
    ]);
    expect(visible[0]?.hasChildren).toBe(true);
    expect(visible[2]?.hasChildren).toBe(false);
  });

  it("hides the whole subtree of a collapsed row, not just its children", () => {
    const visible = visibleRows(TREE, new Set(["root"]));
    expect(visible.map((entry) => entry.row.key)).toEqual(["root", "other"]);
    expect(visible[0]?.collapsed).toBe(true);
  });

  it("collapses an inner node without touching its siblings", () => {
    const visible = visibleRows(TREE, new Set(["a"]));
    expect(visible.map((entry) => entry.row.key)).toEqual([
      "root",
      "a",
      "b",
      "other",
    ]);
  });

  it("ignores a collapsed key on a row that has no children", () => {
    const visible = visibleRows(TREE, new Set(["other"]));
    expect(visible).toHaveLength(TREE.length);
    expect(visible.at(-1)?.collapsed).toBe(false);
  });

  it("toggles a key into and back out of the collapsed set", () => {
    const once = toggleKey(new Set<string>(), "a");
    expect([...once]).toEqual(["a"]);
    expect([...toggleKey(once, "a")]).toEqual([]);
  });
});
