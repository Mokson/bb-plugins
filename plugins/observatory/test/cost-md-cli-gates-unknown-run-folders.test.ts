// `buildCostMd` reads `<folder>/LEDGER.md` from disk, so an unchecked folder
// argument makes `cost-md` an arbitrary-file read on the operator's say-so.
// The agent tool already gates on the ledger; the CLI applies the same gate,
// and the inside-the-run-folder guard stays symlink-aware.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runSpendCommand } from "../src/server.js";
import { assertInside } from "../src/audit/pack.js";
import { TempDatabase } from "./fakes.js";

let temp!: TempDatabase;
let folder: string | null = null;
beforeEach(() => {
  temp = new TempDatabase();
});
afterEach(() => {
  temp.dispose();
  if (folder) rmSync(folder, { recursive: true, force: true });
  folder = null;
});

function deps() {
  const store = temp.open();
  return { db: store.db, store, ttlMinutes: 60 };
}

test("cost-md refuses a folder the ledger never attributed", () => {
  const result = runSpendCommand(deps, "cost-md", ["/runs/no-such-run"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toMatch(/no such run folder in the ledger/u);
});

test("cost-md still writes COST.md for a known run folder", () => {
  folder = mkdtempSync(join(tmpdir(), "observatory-run-"));
  const store = temp.open();
  store.upsertThread({ thread_id: "t1", run_folder: folder });
  store.upsertTurn({
    thread_id: "t1",
    turn_id: "u1",
    completed_at: "2026-09-01T00:00:00.000Z",
    cost_usd: 1.25,
  });

  const result = runSpendCommand(
    () => ({ db: store.db, store, ttlMinutes: 60 }),
    "cost-md",
    [folder],
  );

  expect(result.exitCode).toBe(0);
  expect(existsSync(join(folder, "COST.md"))).toBe(true);
});

test("assertInside lets an interior .. through on a real run folder", () => {
  const runFolder = mkdtempSync(join(tmpdir(), "observatory-run-"));
  folder = runFolder;

  // A `..` that stays inside is containment-safe, and the parent may itself
  // sit under a symlink (every tmpdir on macOS): the guard must not refuse
  // its own run folder over two spellings of one directory.
  expect(
    assertInside(runFolder, join(runFolder, "sub", "..", "audit.json")),
  ).toBe(join(runFolder, "audit.json"));
  expect(() =>
    assertInside(runFolder, join(runFolder, "..", "audit.json")),
  ).toThrow(/outside the run folder/u);
});
