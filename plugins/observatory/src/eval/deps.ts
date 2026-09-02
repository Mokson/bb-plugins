// What the spending half of eval needs from the host.
//
// It is a separate type from `EvalDeps` on purpose. Every read surface — the
// rpc, `eval list`, `eval show` — works with the store and the cases
// directory alone, and keeping the SDK handle out of that type means a read
// path can never accidentally acquire the ability to spawn a thread.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Database } from "better-sqlite3";

export interface EvalLiveDeps {
  bb: BbPluginApi;
  /** The plugin database, for the ledger the budget checks read. */
  db: Database;
  /** Overrides `~/.agents/skills/deliver/scripts/check-ledger.sh`. */
  checkLedgerScript?: string;
  judgeFixturesDir?: string;
  /** Where `judge-validate` spawns its threads when `--project` is absent. */
  defaultProjectId?: string;
}
