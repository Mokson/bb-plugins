// Read-only evidence probe: render the fixed COST.md header for one run
// folder against the live ledger, without installing the build.
//
// The install path is blocked by a cross-seat migration conflict (the shared
// database carries a partial `obs_signal_dedupe_open` unique index this branch
// predates), so this opens the same database READONLY and calls the same
// `buildCostMd` the CLI does.
import Database from "better-sqlite3";
import { buildCostMd } from "../../../../../src/spend/cost-md.ts";

const [folder] = process.argv.slice(2);
const db = new Database(
  `${process.env.HOME}/.bb/plugins/observatory/data.db`,
  { readonly: true },
);
process.stdout.write(
  buildCostMd(db, { runFolder: folder }).content.split("\n").slice(0, 7).join("\n") + "\n",
);
db.close();
