// A manual probe that runs the REAL watch rules over this machine's REAL bb
// ledger, in the shape of its sibling `real-data-probe.ts`.
//
// Not a test: it asserts nothing and its numbers change every day. It exists
// because the fixtures prove each rule against events this repository wrote,
// and the question they cannot answer is whether the same rules fire on the
// item shapes bb actually emits — the fingerprints, the kinds, the timestamps.
//
// Run it explicitly:
//   npx tsx test/watch-real-data-probe.ts [threadIdOrTitleFragment]
//
// The plugin's live database is COPIED first and the copy is what gets opened;
// nothing here writes to ~/.bb. The copy is deleted on the way out.
import { copyFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createWatchRuntime } from "../src/watch/module.js";
import { buildExplain, buildInbox, buildWatchList } from "../src/watch/views.js";
import { formatExplain, formatWatchList } from "../src/watch/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const livePath = join(homedir(), ".bb", "plugins", "observatory", "data.db");
const copyPath = join(here, "..", ".watch-probe-scratch.db");
const filter = process.argv[2] ?? "obs-test";

/** Only what the runtime touches. Empty kv, so every threshold answers from
 * the setting layer and the probe reflects shipped defaults. */
const published: Array<{ channel: string; payload: unknown }> = [];
const bb = {
  log: { info() {}, warn() {}, error: console.error, debug() {} },
  realtime: {
    publish: (channel: string, payload: unknown) =>
      published.push({ channel, payload }),
  },
  storage: {
    kv: { get: async () => undefined, set: async () => {}, delete: async () => {} },
  },
} as unknown as BbPluginApi;

async function main(): Promise<void> {
  copyFileSync(livePath, copyPath);
  const db = new Database(copyPath);
  const runtime = createWatchRuntime({ bb, db, settings: async () => ({}) });
  await runtime.refresh();

  const threads = db
    .prepare<
      [string, string],
      { thread_id: string; title: string | null; status: string | null }
    >(
      `SELECT thread_id, title, status FROM obs_thread
        WHERE thread_id = ? OR title LIKE '%' || ? || '%'
        ORDER BY last_seen_at DESC LIMIT 10`,
    )
    .all(filter, filter);

  console.log(`=== threads matching "${filter}" in the real ledger ===`);
  for (const row of threads) {
    console.log(` ${row.thread_id}  ${row.status}  ${row.title}`);
  }
  if (threads.length === 0) {
    console.log(" none");
  }

  console.log("\n=== the real rules, evaluated over each ===");
  for (const row of threads) {
    // The list and the sweep only cover ACTIVE threads. These have finished,
    // so the engine is driven at the thread directly — the same call the
    // drain hook and the sweep make.
    const result = runtime.engine.evaluateThread(row.thread_id);
    const transitions =
      result?.transitions.map((t) => `${t.rule}/${t.state}`).join(", ") || "none";
    console.log(
      ` ${row.thread_id}: opened ${result?.opened ?? 0} closed ${
        result?.closed ?? 0
      } -> ${transitions}`,
    );
  }

  console.log("\n=== bb observatory watch ===");
  console.log(formatWatchList(buildWatchList(runtime.queries, Date.now())));

  for (const row of threads) {
    if (runtime.queries.signalsForThread(row.thread_id).length === 0) continue;
    console.log(`\n=== bb observatory watch explain ${row.thread_id} ===`);
    console.log(formatExplain(buildExplain(runtime.queries, row.thread_id)));
  }

  const inbox = buildInbox(runtime.queries, 10);
  console.log("\n=== observatory_inbox ===");
  console.log(JSON.stringify(inbox.counts));
  for (const row of inbox.rows.slice(0, 6)) {
    console.log(
      ` [${row.severity}] ${row.source}/${row.kind} ${row.threadId ?? "-"}  ${row.subtitle}`,
    );
  }
  console.log(`\nrealtime publishes: ${published.length}`);
  db.close();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(copyPath, { force: true }));
