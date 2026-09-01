// The motivating scenario, end to end: point the scan at a project that has
// every surface, and get back a persisted snapshot whose composition, imports,
// duplicates and per-thread compaction estimate all line up.
import { afterEach, beforeEach, expect, test } from "vitest";
import { contextThread, takeSnapshot } from "../src/context/snapshot.js";
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

const SHARED_RULE =
  "always run the repository checks before handing work back and never delete a file the plan did not name";

test("a scan prices every surface, follows imports and persists one snapshot", () => {
  tree.write(
    "project/AGENTS.md",
    `# Project\n\n${SHARED_RULE}\n\n@./docs/rules.md\n`,
  );
  tree.write("project/docs/rules.md", "Imported rules: keep diffs small.\n");
  tree.write("home/.claude/CLAUDE.md", "# Global\n\nUse the tracker.\n");
  tree.skill("home/.agents/skills", "pr", `${SHARED_RULE} when opening a PR.`);
  tree.write(
    "project/.mcp.json",
    JSON.stringify({ mcpServers: { linear: { tools: ["create_issue"] } } }),
  );
  const store = temp.open();

  const view = takeSnapshot(
    {
      db: store.db,
      store,
      home: tree.home,
      pluginTools: [{ name: "observatory_cost", description: "Cost report." }],
    },
    { cwd: tree.cwd, refresh: true },
  );

  const surfaces = new Set(view.blocks.map((block) => block.surface));
  expect([...surfaces].sort()).toEqual([
    "instruction",
    "mcp",
    "plugin-tool",
    "skill",
  ]);
  // The `@./docs/rules.md` import is billed as its own block.
  expect(
    view.blocks.some((block) => block.path?.endsWith("docs/rules.md")),
  ).toBe(true);
  expect(view.snapshot.totalEstTokens).toBeGreaterThan(0);
  expect(
    view.composition.reduce((sum, entry) => sum + entry.share, 0),
  ).toBeCloseTo(1, 6);
  // The rule lives in both AGENTS.md and the skill description.
  expect(view.duplicates.length).toBeGreaterThan(0);

  const rows = store.db
    .prepare("SELECT COUNT(*) AS n FROM obs_ctx_block WHERE snapshot_id = ?")
    .get(view.snapshot.id) as { n: number };
  expect(rows.n).toBe(view.blocks.length);
});

test("a thread's compaction estimate is history times its tool-result share", () => {
  tree.write("project/AGENTS.md", "# Project\n");
  const store = temp.open();
  const view = takeSnapshot(
    { db: store.db, store, home: tree.home, pluginTools: [] },
    { cwd: tree.cwd, refresh: true },
  );

  store.upsertThread({ thread_id: "t1", cwd: tree.cwd });
  store.upsertTurn({
    thread_id: "t1",
    turn_id: "u1",
    completed_at: "2026-09-01T00:00:00.000Z",
    context_used: 10_000,
    context_window: 200_000,
  });
  for (const [id, kind] of [
    ["i1", "toolCall"],
    ["i2", "fileChange"],
  ] as const) {
    store.upsertItem({ item_id: id, thread_id: "t1", kind });
  }

  const thread = contextThread(
    { db: store.db, store, home: tree.home, pluginTools: [] },
    "t1",
  );

  expect(thread.snapshotId).toBe(view.snapshot.id);
  expect(thread.contextUsed).toBe(10_000);
  expect(thread.toolResultShare).toBe(0.5);
  const history = 10_000 - view.snapshot.totalEstTokens;
  expect(thread.historyShare).toBeCloseTo(history / 10_000, 6);
  expect(thread.compactionEstimateTokens).toBe(Math.round(history * 0.5));
});
