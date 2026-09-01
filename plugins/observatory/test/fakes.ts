// Shared test doubles. Every backend test runs against the SDK's own fake
// plugin host, so `bb` here is the same `BbPluginApi` the server compiles
// against and its storage is a real sqlite file in a temp directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS, ObservatoryStore } from "../src/core/store.js";
import { ModuleRegistry } from "../src/module.js";

/** A file-backed store whose handle can be closed and reopened. */
export class TempDatabase {
  readonly dir: string;
  readonly path: string;
  private handle: Database.Database | null = null;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "observatory-test-"));
    this.path = join(this.dir, "data.db");
  }

  openDatabase(): Database.Database {
    this.close();
    const db = new Database(this.path);
    applyTestMigrations(db);
    this.handle = db;
    return db;
  }

  open(): ObservatoryStore {
    return new ObservatoryStore(this.openDatabase());
  }

  close(): void {
    this.handle?.close();
    this.handle = null;
  }

  dispose(): void {
    this.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * The host's migration semantics, reimplemented for tests that hold a raw
 * database rather than a fake host: index is the migration id, and an applied
 * index is skipped.
 */
export function applyTestMigrations(db: Database.Database): void {
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
  db.transaction(() => {
    MIGRATIONS.forEach((statement, index) => {
      if (applied.has(index)) return;
      db.exec(statement);
      insert.run(index, Date.now());
    });
  })();
}

export interface FakeHarness extends FakePluginHost {
  store: ObservatoryStore;
  registry: ModuleRegistry;
  settings(): Promise<Record<string, string | boolean | undefined>>;
}

/**
 * A fake host with the schema applied and a registry wired to it. `settings`
 * is a plain map the test controls, standing in for `bb.settings.define`.
 */
export function makeHarness(
  settingValues: Record<string, string | boolean | undefined> = {},
): FakeHarness {
  const host = createFakePluginHost({ pluginId: "observatory" });
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, MIGRATIONS);
  const store = new ObservatoryStore(db);
  const settings = async () => settingValues;
  const registry = new ModuleRegistry({
    bb: host.bb,
    db: () => db,
    settings,
  });
  return { ...host, store, registry, settings };
}
