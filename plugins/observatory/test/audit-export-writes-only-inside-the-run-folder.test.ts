import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { assertInside, writeAuditPack } from "../src/audit/pack.js";
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

test("a path that escapes the run folder is refused", () => {
  expect(() => assertInside("/tmp/run", "/tmp/run/../audit.json")).toThrow(
    /outside the run folder/u,
  );
  expect(assertInside("/tmp/run", "/tmp/run/audit.json")).toBe(
    "/tmp/run/audit.json",
  );
});

test("the export writes audit.json, audit.md and COST.md into the run folder", () => {
  folder = mkdtempSync(join(tmpdir(), "observatory-run-"));
  const store = temp.open();
  store.upsertThread({
    thread_id: "t1",
    run_folder: folder,
    title: "[claude:high] implementer",
    seat: "implementer",
  });
  store.upsertTurn({
    thread_id: "t1",
    turn_id: "u1",
    completed_at: "2026-09-01T00:00:00.000Z",
    cost_usd: 1.25,
    input_tokens: 100,
    output_tokens: 10,
    tool_calls: 3,
  });

  const written = writeAuditPack({ db: store.db, store }, folder);

  expect(written).toHaveLength(3);
  for (const path of written) {
    expect(path.startsWith(folder)).toBe(true);
    expect(existsSync(path)).toBe(true);
  }
  expect(JSON.parse(readFileSync(join(folder, "audit.json"), "utf8"))).toMatchObject(
    { runFolder: folder },
  );
  expect(readFileSync(join(folder, "audit.md"), "utf8")).toContain("# Audit:");
  expect(readFileSync(join(folder, "COST.md"), "utf8")).toContain("snapshot");
});
