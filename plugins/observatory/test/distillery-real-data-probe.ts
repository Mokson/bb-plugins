// Read-only probe: real ledgers + a copy of the live ledger DB, into a TEMP
// database. Nothing under ~/.bb or ~/.agents is written.
import Database from "better-sqlite3";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../src/core/migrations.js";
import { DistilleryStore } from "../src/distillery/store.js";
import { scanAll, knownRunFolders } from "../src/distillery/signals.js";
import { clusterCorrections } from "../src/distillery/cluster.js";

const dir = mkdtempSync(join(tmpdir(), "distill-probe-"));
const live = join(homedir(), ".bb/plugins/observatory/data.db");
const copy = join(dir, "data.db");
copyFileSync(live, copy);

const db = new Database(copy);
db.exec("CREATE TABLE IF NOT EXISTS _probe (x)");
for (const s of MIGRATIONS) { try { db.exec(s); } catch { /* already there */ } }

const folders = knownRunFolders(db);
console.log("run folders:", folders.length);
for (const f of folders) console.log("  ", f);

const { corrections, bySource } = scanAll(
  { runFolders: folders, db, now: () => new Date().toISOString() },
  { warn: (m: string) => console.log("WARN", m) },
);

console.log("\ncounts per source:");
for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(5)}  ${k}`);
}
console.log("  total:", corrections.length);

const store = new DistilleryStore(db);
let inserted = 0;
for (const c of corrections) if (store.insertCorrection(c) !== null) inserted++;
console.log("  stored:", inserted);

const clusters = clusterCorrections(store.corrections());
const qualifying = clusters.filter((c) => c.qualifies);
console.log(`\nclusters: ${clusters.length}, qualifying: ${qualifying.length}`);
console.log("\ntop 5 clusters (signatures only):");
for (const c of clusters.slice(0, 5)) {
  console.log(`  ${c.size}x / ${c.runs} runs  [${c.causeClass ?? "untagged"}] ${c.signature}`);
}
console.log("\na draft batch would send:", Math.min(qualifying.length, 5), "cluster(s)");
