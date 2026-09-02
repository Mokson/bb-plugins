// `bb.storage.migrate` skips applied statements BY INDEX, and branches appended
// to the list concurrently, so a live database can carry an index marked
// applied whose statement was a different branch's. The table that index should
// have created is then simply missing, and no future migrate pass will make it.
// `applyMigrations` therefore re-executes every statement itself, which only
// holds while every statement is idempotent.
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, applyMigrations } from "../src/core/store.js";
import { TempDatabase } from "./fakes.js";

/** Every table the schema owns; the panel and the CLI read all of them. */
const EXPECTED_TABLES = [
  "obs_action",
  "obs_ctx_block",
  "obs_ctx_snapshot",
  "obs_item",
  "obs_log_file",
  "obs_log_turn",
  "obs_match",
  "obs_meta",
  "obs_root",
  "obs_signal",
  "obs_thread",
  "obs_turn",
  "pricing_catalog",
];

function tablesOf(db: Database.Database): string[] {
  return db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name)
    .filter((name) => !name.startsWith("sqlite_"));
}

/** The host's semantics: index is the id, an applied index is skipped. */
function hostMigrate(db: Database.Database, statements: string[]): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    db
      .prepare<[], { id: number }>("SELECT id FROM _bb_migrations")
      .all()
      .map((row) => row.id),
  );
  const insert = db.prepare(
    "INSERT INTO _bb_migrations (id, applied_at) VALUES (?, ?)",
  );
  statements.forEach((statement, index) => {
    if (applied.has(index)) return;
    db.exec(statement);
    insert.run(index, Date.now());
  });
}

let temp: TempDatabase | undefined;
let db: Database.Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
  temp?.dispose();
  temp = undefined;
});

/** A database with no schema at all, unlike `TempDatabase.openDatabase`. */
function freshDatabase(): Database.Database {
  temp = new TempDatabase();
  db = new Database(temp.path);
  return db;
}

describe("migrations", () => {
  it("create every table on a fresh database and survive a second pass", () => {
    const fresh = freshDatabase();

    applyMigrations(fresh, hostMigrate);
    const afterFirst = tablesOf(fresh);
    applyMigrations(fresh, hostMigrate);

    expect(afterFirst).toEqual(expect.arrayContaining(EXPECTED_TABLES));
    expect(tablesOf(fresh)).toEqual(afterFirst);
  });

  it("create the tables a drifted index left out, without a migrate pass", () => {
    const fresh = freshDatabase();
    // The drift: the host recorded every index as applied, but the statements
    // at the last four came from another branch, so their tables never landed.
    const skipped = 4;
    const drifted = (
      database: Database.Database,
      statements: string[],
    ): void => {
      hostMigrate(database, statements.slice(0, statements.length - skipped));
      const insert = database.prepare(
        "INSERT INTO _bb_migrations (id, applied_at) VALUES (?, ?)",
      );
      for (let i = statements.length - skipped; i < statements.length; i += 1) {
        insert.run(i, Date.now());
      }
    };

    applyMigrations(fresh, drifted);

    expect(tablesOf(fresh)).toEqual(expect.arrayContaining(EXPECTED_TABLES));
    expect(
      fresh
        .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM _bb_migrations")
        .get()!.n,
    ).toBe(MIGRATIONS.length);
  });
});
