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
  /**
   * Flush core's pending events for one thread into the ledger.
   *
   * Ingest drains on a background loop, so a trial that finishes and reads its
   * metrics in the same tick sees turn rows without their usage: one run
   * reported 8 tool calls, 0 tokens and 0.00 usd while the ledger picked the
   * real numbers up seconds later. The runner awaits this before the harvest
   * read. Optional, so a test can run with no core module behind it.
   */
  drainThread?(threadId: string): Promise<number>;
  /** Overrides `~/.agents/skills/deliver/scripts/check-ledger.sh`. */
  checkLedgerScript?: string;
  judgeFixturesDir?: string;
  /** Where `judge-validate` spawns its threads when `--project` is absent. */
  defaultProjectId?: string;
}
