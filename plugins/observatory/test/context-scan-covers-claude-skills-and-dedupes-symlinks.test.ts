// `~/.claude/skills` is a mounted root on this machine, and it is commonly a
// symlink to `~/.agents/skills`. Missing it undercounts the prefix; counting a
// symlinked skill twice doubles it.
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { scanSurfaces } from "../src/context/scan.js";
import { TempTree } from "./context-fixtures.js";

let tree!: TempTree;
beforeEach(() => {
  tree = new TempTree();
});
afterEach(() => tree.dispose());

test("a skill under ~/.claude/skills is part of the prefix", () => {
  tree.skill("home/.claude/skills", "gamma", "Use when the user asks for gamma.");
  const blocks = scanSurfaces({ cwd: tree.cwd, home: tree.home });

  expect(blocks.filter((block) => block.surface === "skill").map((b) => b.name)).toEqual(
    ["gamma"],
  );
});

test("one skill reached through two roots is billed once", () => {
  tree.skill("home/.agents/skills", "alpha", "Use when the user asks for alpha.");
  tree.ensure("home/.claude");
  symlinkSync(
    join(tree.root, "home", ".agents", "skills"),
    join(tree.root, "home", ".claude", "skills"),
  );

  const blocks = scanSurfaces({ cwd: tree.cwd, home: tree.home });

  expect(blocks.filter((block) => block.surface === "skill")).toHaveLength(1);
});
