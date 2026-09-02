// The store is the redaction chokepoint: no scanner, and no future caller,
// can put unmasked text into `corrections.preview_redacted`.
//
// The test spies on the INSERTS rather than on `redact`, because the thing
// that must hold is a property of what lands in the database, not of which
// function someone remembered to call.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TempDatabase } from "./fakes.js";
import { DistilleryStore } from "../src/distillery/store.js";
import { hasUnredacted, redact } from "../src/distillery/redact.js";
import { scanAll } from "../src/distillery/signals.js";

/** A database per test: `TempDatabase` is file-backed, so a shared one would
 * carry the first test's rows into the second. */
const opened: TempDatabase[] = [];
function freshDb() {
  const temp = new TempDatabase();
  opened.push(temp);
  return temp.openDatabase();
}
afterEach(() => {
  for (const temp of opened.splice(0)) temp.dispose();
});

/** A run folder whose every artifact is stuffed with secrets. */
function seedLeakyRun(): string {
  const root = mkdtempSync(join(tmpdir(), "distillery-leak-"));
  const folder = join(root, "repo", "docs", "specs", "run-1");
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "LEDGER.md"),
    [
      "## nudges",
      "- n1 | tooling-gap | the seat pasted sk-proj-abcdefghijklmnopqrstuvwxyz012345 into MKL-473 | -",
      "- n2 | env-friction | build broke under /Users/mokson/Projects/x, mailed max@example.com | -",
      "",
      "## gates",
      "- g1 | ship with a token in the log | rejected, ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 must go",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(folder, "QA.md"),
    [
      "| Scenario | Status | Evidence | Notes |",
      "| --- | --- | --- | --- |",
      "| login against 203.0.113.42 | Fail | none | key AKIAIOSFODNN7EXAMPLE leaked |",
      "",
    ].join("\n"),
    "utf8",
  );
  return root;
}

describe("no unredacted preview is ever written", () => {
  it("stores nothing a redaction rule would still mask", () => {
    const root = seedLeakyRun();
    const db = freshDb();
    const store = new DistilleryStore(db);
    const folder = join(root, "repo", "docs", "specs", "run-1");

    // Spy at the seam every write passes through.
    const written: string[] = [];
    const realInsert = store.insertCorrection.bind(store);
    store.insertCorrection = (input) => {
      written.push(input.preview.text);
      return realInsert(input);
    };

    const { corrections } = scanAll({
      runFolders: [folder],
      db: null,
      now: () => new Date("2026-09-01T00:00:00Z").toISOString(),
    });
    expect(corrections.length).toBeGreaterThan(0);
    for (const item of corrections) store.insertCorrection(item);

    expect(written.length).toBeGreaterThan(0);
    for (const preview of written) {
      expect(hasUnredacted(preview)).toBe(false);
    }

    // And the same holds for what the database actually holds, which is the
    // claim that matters — the spy only proves what was offered to it.
    const rows = db
      .prepare<[], { preview_redacted: string }>(
        "SELECT preview_redacted FROM corrections",
      )
      .all();
    expect(rows.length).toBe(written.length);
    // The mask keeps the secret's KIND (`[redacted:ghp_…]`) and drops all of
    // its material, so the assertion is about the key bodies, not the prefix
    // hint a reviewer needs to know what leaked.
    for (const row of rows) {
      expect(hasUnredacted(row.preview_redacted)).toBe(false);
      expect(row.preview_redacted).not.toContain(
        "abcdefghijklmnopqrstuvwxyz012345",
      );
      expect(row.preview_redacted).not.toContain(
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
      );
      expect(row.preview_redacted).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(row.preview_redacted).not.toContain("max@example.com");
      expect(row.preview_redacted).not.toContain("/Users/mokson");
      expect(row.preview_redacted).not.toContain("MKL-473");
    }

    // Per-rule counts survive the round trip, so a reviewer can see how much
    // was masked out of the evidence they are judging.
    const counts = db
      .prepare<[], { redaction_counts: string | null }>(
        "SELECT redaction_counts FROM corrections",
      )
      .all()
      .map((row) => row.redaction_counts ?? "{}");
    expect(counts.some((value) => value.includes("secret"))).toBe(true);

    rmSync(root, { recursive: true, force: true });
  });

  it("throws rather than quietly masking when a caller bypasses redact", () => {
    const db = freshDb();
    const store = new DistilleryStore(db);
    // The only way to get here is a cast, which is exactly the mistake the
    // runtime assertion exists to catch.
    const forged = {
      text: "leaked sk-proj-abcdefghijklmnopqrstuvwxyz012345",
      counts: {},
      truncated: false,
    } as unknown as ReturnType<typeof redact>;

    expect(() =>
      store.insertCorrection({
        source: "ledger-nudge",
        signature: "sig",
        causeClass: null,
        preview: forged,
        runFolder: null,
        threadId: null,
        at: "2026-09-01T00:00:00.000Z",
        confidence: 0.9,
      }),
    ).toThrow(/unredacted/);

    expect(
      db.prepare("SELECT COUNT(*) AS n FROM corrections").get(),
    ).toEqual({ n: 0 });
  });
});
