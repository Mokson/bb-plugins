// A calibration fitted from the same evidence it is judged against always
// looks perfect. The snapshot has to price with the factor learned LAST time,
// or `totalEstTokens` is just the observed cache write written back out.
import { afterEach, beforeEach, expect, test } from "vitest";
import { takeSnapshot } from "../src/context/snapshot.js";
import { calibrationKey } from "../src/context/estimate.js";
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

test("the first scan is priced uncalibrated and does not equal the observed prefix", () => {
  tree.write("project/CLAUDE.md", "rule text ".repeat(50));
  const store = temp.open();
  store.db
    .prepare(
      `INSERT INTO obs_log_turn (log_key, provider, provider_thread_id, ts, cache_write)
       VALUES ('k1', 'claude-code', 's1', ?, 900000)`,
    )
    .run(Date.now());

  const view = takeSnapshot(
    { db: store.db, store, home: tree.home, pluginTools: [] },
    { cwd: tree.cwd, refresh: true },
  );

  expect(view.snapshot.calibrationFactor).toBeNull();
  expect(view.snapshot.totalEstTokens).not.toBe(900_000);
  // The fit still happened; it is waiting for the next scan.
  expect(
    Number(store.getMeta(calibrationKey("claude-code"))),
  ).toBeGreaterThan(0);
});

test("the second scan applies the factor the first one persisted", () => {
  tree.write("project/CLAUDE.md", "rule text ".repeat(50));
  const store = temp.open();
  store.db
    .prepare(
      `INSERT INTO obs_log_turn (log_key, provider, provider_thread_id, ts, cache_write)
       VALUES ('k1', 'claude-code', 's1', ?, 900000)`,
    )
    .run(Date.now());
  const deps = { db: store.db, store, home: tree.home, pluginTools: [] };

  const first = takeSnapshot(deps, { cwd: tree.cwd, refresh: true });
  const second = takeSnapshot(deps, { cwd: tree.cwd, refresh: true });

  const applied = Number(store.getMeta(calibrationKey("claude-code")));
  expect(second.snapshot.calibrationFactor).toBeCloseTo(applied, 6);
  expect(second.snapshot.totalEstTokens).toBeGreaterThan(
    first.snapshot.totalEstTokens,
  );
  // Priced with the prior fit, the second scan lands on the observed prefix,
  // and its error is measured against that same prior rather than a refit.
  expect(second.snapshot.calibrationError).toBeCloseTo(0, 3);
});
