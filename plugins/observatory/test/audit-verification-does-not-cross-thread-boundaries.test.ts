// A run folder holds several seats. `seq` counts within one thread, so ordered
// together the two interleave and one seat's `npm test` ends up vouching for
// another seat's edit.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { auditSession } from "../src/audit/pack.js";
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

test("a command in one thread never verifies an edit in another", () => {
  folder = mkdtempSync(join(tmpdir(), "observatory-run-"));
  const store = temp.open();
  for (const threadId of ["t1", "t2"]) {
    store.upsertThread({ thread_id: threadId, run_folder: folder, seat: threadId });
    store.upsertTurn({
      thread_id: threadId,
      turn_id: `${threadId}-u1`,
      completed_at: "2026-09-01T00:00:00.000Z",
      cost_usd: 0.5,
    });
  }
  // t1 edits and never runs anything. t2 runs the tests at the same seq, so a
  // merged ordering would place it after t1's edit.
  store.upsertItem({
    item_id: "t1-i1",
    thread_id: "t1",
    kind: "fileChange",
    path: "src/a.ts",
    seq: 1,
    completed_at: "2026-09-01T00:01:00.000Z",
  });
  store.upsertItem({
    item_id: "t2-i2",
    thread_id: "t2",
    kind: "commandExecution",
    name: "npm test",
    seq: 2,
    completed_at: "2026-09-01T00:02:00.000Z",
  });

  const session = auditSession({ db: store.db, store }, { runFolder: folder });

  expect(session.threads).toEqual(["t1", "t2"]);
  expect(session.unverifiedEdits.map((edit) => edit.path)).toEqual(["src/a.ts"]);
  // The counts are still the run's totals, merged across both threads.
  expect(session.verification.commands).toBe(1);
  expect(session.verification.verificationCommands).toBe(1);
});
