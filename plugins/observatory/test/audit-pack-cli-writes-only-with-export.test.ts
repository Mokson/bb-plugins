// `--pack` used to drop `--export` on the floor: the usage line lists them
// together, the agent tool accepts both, but the CLI pack branch never passed
// the flag through, so `audit <runFolder> --pack --export` was a read wearing
// a write's flags. The pack branch now forwards the flag like the tool does.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { runAuditCommand } from "../src/server.js";
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

function seed(runFolder: string): void {
  const store = temp.open();
  store.upsertThread({ thread_id: "t1", run_folder: runFolder });
  store.upsertTurn({
    thread_id: "t1",
    turn_id: "u1",
    completed_at: "2026-09-01T00:00:00.000Z",
    cost_usd: 1.25,
    tool_calls: 2,
  });
}

function deps() {
  const store = temp.open();
  return { db: store.db, store };
}

test("audit <runFolder> --pack alone writes nothing", () => {
  folder = mkdtempSync(join(tmpdir(), "observatory-run-"));
  seed(folder);

  const cli = runAuditCommand(deps, "audit", [folder, "--pack"]);

  expect(cli.exitCode).toBe(0);
  expect(JSON.parse(cli.stdout!).written).toEqual([]);
  expect(existsSync(join(folder, "audit.json"))).toBe(false);
  expect(existsSync(join(folder, "audit.md"))).toBe(false);
  expect(existsSync(join(folder, "COST.md"))).toBe(false);
});

test("audit <runFolder> --pack --export writes the three artifacts", () => {
  folder = mkdtempSync(join(tmpdir(), "observatory-run-"));
  seed(folder);

  const cli = runAuditCommand(deps, "audit", [folder, "--pack", "--export"]);

  expect(cli.exitCode).toBe(0);
  const written = JSON.parse(cli.stdout!).written as string[];
  expect(written.map((path) => path.replace(`${folder}/`, "")).sort()).toEqual(
    ["COST.md", "audit.json", "audit.md"],
  );
  for (const path of written) {
    expect(existsSync(path)).toBe(true);
  }
});
