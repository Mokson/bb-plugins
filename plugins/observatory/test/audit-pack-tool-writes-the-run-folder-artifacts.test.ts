// The agent-facing pack and the files the retro seat reads have to describe
// the same run, so asking for a run folder's pack leaves the three artifacts
// in it and says where they went.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { auditPackWithExport } from "../src/audit/pack.js";
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

function seed(runFolder: string | null): void {
  const store = temp.open();
  store.upsertThread({
    thread_id: "t1",
    seat: "implementer",
    ...(runFolder === null ? {} : { run_folder: runFolder }),
  });
  store.upsertTurn({
    thread_id: "t1",
    turn_id: "u1",
    completed_at: "2026-09-01T00:00:00.000Z",
    cost_usd: 1.25,
    input_tokens: 100,
    output_tokens: 10,
  });
}

test("a run-folder target writes audit.json, audit.md and COST.md and returns them", () => {
  folder = mkdtempSync(join(tmpdir(), "observatory-run-"));
  seed(folder);
  const store = temp.open();

  const pack = auditPackWithExport({ db: store.db, store }, { runFolder: folder });

  expect(pack.written.map((path) => path.replace(`${folder}/`, "")).sort()).toEqual(
    ["COST.md", "audit.json", "audit.md"],
  );
  for (const path of pack.written) {
    expect(path.startsWith(folder)).toBe(true);
    expect(existsSync(path)).toBe(true);
  }
});

test("a thread with no run folder writes nothing and says so", () => {
  seed(null);
  const store = temp.open();

  const pack = auditPackWithExport({ db: store.db, store }, { threadId: "t1" });

  expect(pack.runFolder).toBeNull();
  expect(pack.written).toEqual([]);
});
