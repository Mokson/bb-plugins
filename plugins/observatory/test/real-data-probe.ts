// A manual probe against this machine's REAL provider logs.
//
// Not a test: it asserts nothing, needs data no repository can carry, and its
// numbers change every day. It exists to answer the one question the fixtures
// cannot, which is whether the parsers and the resume protocol survive contact
// with 6,000 real session files rather than five curated ones.
//
// Run it explicitly:
//   npx tsx test/real-data-probe.ts
//
// `OBS_PROBE_MAX_BYTES` sets the per-pass budget (default 20MB, the cron's)
// and `OBS_PROBE_PASSES` caps the drain. ~/.claude/projects is 2.7GB here, so
// a full drain needs either a bigger budget or ~140 passes.
//
// It writes a throwaway database into the worktree (never /tmp, never the
// plugin's real storage) and deletes it on the way out.
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { MIGRATIONS } from "../src/core/store.js";
import { LogStore } from "../src/core/store-logs.js";
import { LocalHostClient } from "../src/core/host-client.js";
import { createLogIndexer, defaultLogRoots } from "../src/core/indexer.js";
import { bundledCatalog } from "../src/core/catalog.js";
import { priceTurn } from "../src/core/pricing.js";

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = join(here, "..", ".probe-scratch.db");

async function main() {
  rmSync(dbPath, { force: true });
  const db = new Database(dbPath);
  for (const statement of MIGRATIONS) db.exec(statement);
  const store = new LogStore(db);

  const roots = defaultLogRoots();
  const indexer = createLogIndexer({
    store,
    host: new LocalHostClient(),
    roots,
    log: {
      info: (m) => console.log(`  info  ${m}`),
      warn: (m) => console.log(`  warn  ${m}`),
      error: (m) => console.log(`  error ${m}`),
    },
  });

  console.log("roots:");
  for (const root of roots) console.log(`  ${root}`);

  // Drain the way the cron does: a budgeted pass, repeated until the roots
  // are exhausted. Passes after the first also prove the resume works, since a
  // file already at its end must cost nothing.
  const maxBytes = Number(process.env.OBS_PROBE_MAX_BYTES ?? 20_000_000);
  const maxPasses = Number(process.env.OBS_PROBE_PASSES ?? 60);
  console.log(`\nbudget: ${maxBytes} bytes per pass, at most ${maxPasses} passes`);

  const started = Date.now();
  let files = 0;
  let rows = 0;
  let passes = 0;
  let done = false;
  while (!done && passes < maxPasses) {
    const pass = await indexer.runOnce({ maxBytes });
    files += pass.files;
    rows += pass.rows;
    done = pass.done;
    passes += 1;
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\nrun: passes=${passes} files=${files} rows=${rows} done=${done} in ${elapsed}s`,
  );

  // One more pass with everything already indexed: the steady-state cost.
  const idleStart = Date.now();
  const idle = await indexer.runOnce({ maxBytes });
  console.log(
    `idle pass: files=${idle.files} rows=${idle.rows} in ` +
      `${((Date.now() - idleStart) / 1000).toFixed(1)}s`,
  );

  const byProvider = db
    .prepare(
      `SELECT provider,
              COUNT(*)                                        AS rows,
              COUNT(DISTINCT provider_thread_id)              AS sessions,
              SUM(CASE WHEN cache_read IS NOT NULL
                        AND cache_write IS NOT NULL THEN 1 ELSE 0 END) AS split,
              SUM(CASE WHEN is_sidechain = 1 THEN 1 ELSE 0 END)        AS sidechain,
              SUM(CASE WHEN logged_cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS logged
         FROM obs_log_turn GROUP BY provider ORDER BY rows DESC`,
    )
    .all() as Array<Record<string, number | string>>;

  console.log("\nprovider            rows  sessions  split%  sidechain  logged-cost");
  for (const row of byProvider) {
    const rows = Number(row.rows);
    const share = rows ? ((Number(row.split) / rows) * 100).toFixed(1) : "0.0";
    console.log(
      `${String(row.provider).padEnd(18)}${String(rows).padStart(6)}` +
        `${String(row.sessions).padStart(10)}${share.padStart(8)}` +
        `${String(row.sidechain).padStart(11)}${String(row.logged).padStart(13)}`,
    );
  }

  const catalog = bundledCatalog();
  const priced = db
    .prepare(
      `SELECT provider, model, input, cache_read, cache_write, output, reasoning,
              logged_cost_usd
         FROM obs_log_turn`,
    )
    .all() as Array<Record<string, string | number | null>>;
  const bySource = new Map<string, number>();
  let total = 0;
  for (const row of priced) {
    const result = priceTurn(
      {
        provider: String(row.provider),
        model: (row.model as string) ?? null,
        inputTokens: Number(row.input ?? 0),
        cacheReadTokens: row.cache_read === null ? null : Number(row.cache_read),
        cacheWriteTokens: row.cache_write === null ? null : Number(row.cache_write),
        cachedInputTokens:
          Number(row.cache_read ?? 0) + Number(row.cache_write ?? 0),
        outputTokens: Number(row.output ?? 0),
        reasoningTokens: Number(row.reasoning ?? 0),
        loggedCostUsd:
          row.logged_cost_usd === null ? null : Number(row.logged_cost_usd),
      },
      catalog,
    );
    bySource.set(result.costSource, (bySource.get(result.costSource) ?? 0) + 1);
    total += result.costUsd ?? 0;
  }
  console.log(`\ncost source: ${[...bySource].map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`priced total across every indexed row: $${total.toFixed(2)}`);

  const models = db
    .prepare(
      "SELECT model, COUNT(*) AS n FROM obs_log_turn GROUP BY model ORDER BY n DESC LIMIT 8",
    )
    .all() as Array<{ model: string | null; n: number }>;
  console.log("\ntop models:");
  for (const row of models) console.log(`  ${String(row.model).padEnd(34)}${row.n}`);

  db.close();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-journal`, { force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
