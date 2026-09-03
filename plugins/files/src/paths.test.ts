import { describe, expect, it } from "vitest";
import { buildTree, clampExplorerWidth, EXPLORER_DEFAULT_WIDTH_PX, filterPaths, glyphForEntry, joinRoot, normalizeEntries, truncateEntries } from "./paths";

describe("normalizeEntries", () => {
  it("accepts string and object shapes and sorts", () => {
    expect(
      normalizeEntries([
        "b.ts",
        { path: "a.ts", kind: "file" },
        { relativePath: "dir/", kind: "directory" },
        null,
        42,
      ]),
    ).toEqual([
      { path: "a.ts", kind: "file" },
      { path: "b.ts", kind: "file" },
      { path: "dir", kind: "directory" },
    ]);
  });

  it("returns empty for non-arrays", () => {
    expect(normalizeEntries(null)).toEqual([]);
  });
});

describe("truncateEntries", () => {
  it("passes through small lists", () => {
    const entries = [{ path: "a", kind: "file" as const }];
    expect(truncateEntries(entries)).toEqual({ entries, truncated: false });
  });
});

describe("filterPaths", () => {
  it("matches case-insensitively and skips directories", () => {
    const entries = [
      { path: "src/App.tsx", kind: "file" as const },
      { path: "src", kind: "directory" as const },
      { path: "README.md", kind: "file" as const },
    ];
    expect(filterPaths(entries, "app")).toEqual(["src/App.tsx"]);
    expect(filterPaths(entries, "  ")).toEqual([]);
  });
});

describe("buildTree", () => {
  it("nests files under directories and sorts dirs first", () => {
    const tree = buildTree([
      { path: "b.ts", kind: "file" },
      { path: "src/app.ts", kind: "file" },
      { path: "src", kind: "directory" },
    ]);
    expect(tree.map((n) => n.name)).toEqual(["src", "b.ts"]);
    expect(tree[0]?.children.map((c) => c.name)).toEqual(["app.ts"]);
  });

  it("collapses single-child directory chains", () => {
    const tree = buildTree([{ path: "a/b/c.ts", kind: "file" }]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.name).toBe("a/b");
    expect(tree[0]?.children.map((c) => c.name)).toEqual(["c.ts"]);
  });
});

describe("joinRoot", () => {
  it("joins with exactly one separator", () => {
    expect(joinRoot("/root", "a/b")).toBe("/root/a/b");
    expect(joinRoot("/root/", "a/b")).toBe("/root/a/b");
  });
});

describe("clampExplorerWidth", () => {
  it("clamps to min, absolute max, and preview reserve", () => {
    expect(clampExplorerWidth(100, 1000)).toBe(180);
    expect(clampExplorerWidth(900, 1000)).toBe(620);
    expect(clampExplorerWidth(700, 800)).toBe(560);
    expect(clampExplorerWidth(400, 1000)).toBe(400);
  });

  it("falls back to the default without measurable layout", () => {
    expect(clampExplorerWidth(400, 0)).toBe(EXPLORER_DEFAULT_WIDTH_PX);
    expect(clampExplorerWidth(NaN, 1000)).toBe(EXPLORER_DEFAULT_WIDTH_PX);
  });
});

describe("glyphForEntry", () => {
  it("switches folder glyphs on expansion", () => {
    expect(glyphForEntry("directory", "src", false)).toBe("folder");
    expect(glyphForEntry("directory", "src", true)).toBe("folder-open");
  });

  it("groups files by extension", () => {
    expect(glyphForEntry("file", "a.ts", false)).toBe("file-code");
    expect(glyphForEntry("file", "README.md", false)).toBe("file-text");
    expect(glyphForEntry("file", "logo.png", false)).toBe("file-image");
    expect(glyphForEntry("file", "data.bin", false)).toBe("file");
    expect(glyphForEntry("file", "Makefile", false)).toBe("file");
  });
});