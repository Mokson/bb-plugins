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
  tree.skill("home/.agents/skills", "alpha", "Use when the user asks for alpha.");
  tree.skill("home/.agents/skills", "beta", "Use when the user asks for beta.");
  tree.ensure("project");
}

test("a skill named by one logged session is not dead", () => {
  seedSkills();
  const store = temp.open();
  store.db
    .prepare(
      `INSERT INTO obs_log_turn (log_key, provider, provider_thread_id, ts, skill_names)
       VALUES ('k1', 'claude-code', 's1', ?, '["alpha"]')`,
    )
    .run(Date.now());

  const view = takeSnapshot(deps(store), { cwd: tree.cwd });

  expect(view.dead.map((skill) => skill.name)).toEqual(["beta"]);
});

test("one Skill item in the ledger is enough to keep a skill alive", () => {
  seedSkills();
  const store = temp.open();
  store.upsertThread({ thread_id: "t1" });
  store.upsertItem({
    item_id: "i1",
    thread_id: "t1",
    kind: "Skill",
    name: "beta",
    completed_at: new Date().toISOString(),
  });

  const view = takeSnapshot(deps(store), { cwd: tree.cwd });

  expect(view.dead.map((skill) => skill.name)).toEqual(["alpha"]);
});
