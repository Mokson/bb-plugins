// The `bb.host` entry: this plugin's worker on the machine that holds the
// provider session logs.
//
// It imports the shared contract and the parsers, and nothing else from the
// plugin — no `ObservatoryStore`, no ledger schema, no module registry —
// because this artifact is built and shipped to a daemon on its own. The one
// thing it does reach for is `better-sqlite3`, via the Cursor and OpenCode
// parsers: those providers keep their sessions in a SQLite store rather than a
// file, and that store only exists on this machine.
//
// The handlers are one line each on purpose. Every decision the sweep makes
// (what to resume, what to reparse, what budget is left) lives in
// `LocalHostClient`, so the same logic runs unchanged in-process under test
// and over rpc in production, and this file has no behaviour to drift.
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract, LocalHostClient } from "./core/host-client.js";

const client = new LocalHostClient();

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    ping: () => client.ping(),
    indexBatch: (input) => client.indexBatch(input),
  },
});
