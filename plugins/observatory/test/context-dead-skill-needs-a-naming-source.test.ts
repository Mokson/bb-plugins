// Two ways the dead-skill flag lies. It calls a skill dead because the log
// records `core:core-pr` while the catalog records `core-pr`, and it calls
// every skill dead in a window where nothing named a skill at all.
import { afterEach, beforeEach, expect, test } from "vitest";
import { takeSnapshot } from "../src/context/snapshot.js";
import type { ObservatoryStore } from "../src/core/store.js";
import { TempDatabase } from "./fakes.js";
import { TempTree } from "./context-fixtures.js";

let temp!: TempDatabase;
let tree!: TempTree;
beforeEach(() => {
  temp = new TempDatabase();
  tree = new TempTree();
});
afterEach(() => {
  temp.dispose();
  tree.dispose();
});

function deps(store: ObservatoryStore) {
  return { db: store.db, store, home: tree.home, pluginTools: [] };
}

function seedSkills(): void {
  tree.skill("home/.agents/skills", "core-pr", "Use when opening a PR.");
  tree.skill("home/.agents/skills", "beta", "Use when the user asks for beta.");
  tree.ensure("project");
}

function logSkillNames(store: ObservatoryStore, json: string): void {
  store.db
    .prepare(
      `INSERT INTO obs_log_turn (log_key, provider, provider_thread_id, ts, skill_names)
       VALUES ('k1', 'claude-code', 's1', ?, ?)`,
    )
    .run(Date.now(), json);
}

test("a namespaced skill id in the log matches the catalog's bare name", () => {
  seedSkills();
  const store = temp.open();
  logSkillNames(store, '["core:core-pr"]');

  const view = takeSnapshot(deps(store), { cwd: tree.cwd });

  expect(view.dead.map((skill) => skill.name)).toEqual(["beta"]);
  const pr = view.blocks.find((block) => block.name === "core-pr");
  expect(pr?.dead).toBe("alive");
});

test("with no source naming any skill, the verdict is unknown rather than dead", () => {
  seedSkills();
  const store = temp.open();
  // A non-Claude parser records the column, with nothing in it.
  logSkillNames(store, "[]");

  const view = takeSnapshot(deps(store), { cwd: tree.cwd });

  expect(view.dead).toEqual([]);
  expect(
    view.blocks
      .filter((block) => block.surface === "skill")
      .map((block) => block.dead),
  ).toEqual(["unknown", "unknown"]);
});
