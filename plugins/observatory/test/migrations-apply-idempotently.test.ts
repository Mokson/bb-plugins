// The schema is append-only and keyed by index, so applying it twice against
// the same file must be a no-op rather than an error or a duplicate table.
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, ObservatoryStore } from "../src/core/store.js";
import { TempDatabase, applyTestMigrations } from "./fakes.js";

let temp: TempDatabase | undefined;
afterEach(() => {
  temp?.dispose();
  temp = undefined;
});

describe("migrations", () => {
  it("apply twice over the same database without changing it", () => {
    temp = new TempDatabase();
    const db = temp.openDatabase();
    const tablesAfterFirst = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all();

    applyTestMigrations(db);
    applyTestMigrations(db);

    const tablesAfterThird = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all();
    expect(tablesAfterThird).toEqual(tablesAfterFirst);
    // Each statement is recorded exactly once, so a later append lands at the
    // next index rather than re-running a shipped one.
    const rows = db
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM _bb_migrations")
      .get()!;
    expect(rows.n).toBe(MIGRATIONS.length);
  });

  it("leaves rows written before the second application in place", () => {
    temp = new TempDatabase();
    const store = new ObservatoryStore(temp.openDatabase());
    store.upsertThread({ thread_id: "t1", title: "first" });

    applyTestMigrations(store.db);

    expect(store.counts().threads).toBe(1);
  });
});
