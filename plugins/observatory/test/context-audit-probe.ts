// A manual probe against this machine's REAL ledger, for the two phase 4
// modules. Sibling seats share one installed plugin and one plugin database,
// and `bb.storage.migrate` keys applied migrations by INDEX, so a branch that
// appends a different statement at the same index makes the live database
// disagree with every branch but the one that installed last. This probe
// answers the questions the CLI would answer, on a COPY of that database with
// this branch's two tables present.
//
// Not a test: it asserts nothing and its numbers change every day.
//
//   npx tsx test/context-audit-probe.ts [cwd]
import { copyFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ObservatoryStore } from "../src/core/store.js";
import {
  contextThread,
  formatContext,
  formatSurfaces,
  takeSnapshot,
} from "../src/context/snapshot.js";
import { auditSessions, formatSession, auditSession } from "../src/audit/pack.js";
import { failureRows, formatFailures } from "../src/audit/failures.js";
import { auditInsights, formatInsights } from "../src/audit/insights.js";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = join(here, "..", ".probe-context.db");
const live = join(homedir(), ".bb", "plugins", "observatory", "data.db");

const CTX_TABLES = [
  `CREATE TABLE IF NOT EXISTS obs_ctx_snapshot (
     id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, cwd TEXT NOT NULL,
     taken_at TEXT NOT NULL, provider TEXT, total_est_tokens INTEGER NOT NULL,
     calibration_factor REAL, calibration_error REAL)`,
  `CREATE TABLE IF NOT EXISTS obs_ctx_block (
     snapshot_id INTEGER NOT NULL, surface TEXT NOT NULL, path TEXT,
     name TEXT, bytes INTEGER NOT NULL, est_tokens INTEGER NOT NULL,
     hash TEXT, duplicate_of TEXT, dead INTEGER NOT NULL DEFAULT 0)`,
];

function main(): void {
  rmSync(scratch, { force: true });
  copyFileSync(live, scratch);
  const db = new Database(scratch);
  for (const statement of CTX_TABLES) db.exec(statement);
  const store = new ObservatoryStore(db);
  const deps = { db, store, pluginTools: [] };

  const cwd = process.argv[2] ?? process.cwd();
  const view = takeSnapshot(deps, { cwd, refresh: true });
  console.log("=== context ===");
  console.log(formatContext(view));
  console.log("\n=== surfaces (top 15) ===");
  console.log(formatSurfaces(view).split("\n").slice(0, 16).join("\n"));

  const sessions = auditSessions({ db, store }, "7d");
  console.log(`\n=== audit sessions (7d): ${sessions.length} ===`);
  const costliest = sessions[0];
  if (costliest) {
    console.log(`costliest thread ${costliest.threadId}`);
    console.log(formatSession(auditSession({ db, store }, { threadId: costliest.threadId })));
    console.log("\n=== thread context ===");
    console.log(JSON.stringify(contextThread(deps, costliest.threadId)));
  }

  console.log("\n=== failures (30d) ===");
  console.log(
    formatFailures(failureRows({ db, store }, { range: "30d" })).split("\n").slice(0, 12).join("\n"),
  );
  console.log("\n=== insights (7d) ===");
  console.log(formatInsights(auditInsights({ db, store }, "7d")));

  db.close();
  rmSync(scratch, { force: true });
}

main();
