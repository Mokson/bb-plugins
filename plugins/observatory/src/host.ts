// The `bb.host` entry: this plugin's worker on the machine that holds the
// provider session logs.
//
// It imports nothing but the shared contract — no store, no better-sqlite3 —
// because this artifact is built and shipped to a daemon on its own.
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
