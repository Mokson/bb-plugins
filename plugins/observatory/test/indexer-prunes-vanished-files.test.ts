import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalHostClient } from "../src/core/host-client.js";
import { createLogIndexer } from "../src/core/indexer.js";
import { LogStore } from "../src/core/store-logs.js";
import { TempDatabase } from "./fakes.js";
import { claudeAssistantLine as line } from "./synthetic-logs.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let temp: TempDatabase | null = null;
let dir = "";
afterEach(() => {
  temp?.dispose();
  temp = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const all = { tsFrom: 0, tsTo: Number.MAX_SAFE_INTEGER, provider: "claude-code" };

// A deleted session log is a session that can never be re-derived. Leaving its
// priced rows behind would keep charging a thread nothing can explain, and
// leaving its file row behind would keep a cursor for a file that is gone.
describe("the log indexer", () => {
  it("drops the file row and its turns once the file is gone", async () => {
    dir = mkdtempSync(join(tmpdir(), "observatory-prune-"));
    const root = join(dir, ".claude", "projects", "-p");
    mkdirSync(root, { recursive: true });
    const doomed = join(root, "gone.jsonl");
    const kept = join(root, "kept.jsonl");
    writeFileSync(doomed, line("s-gone", "req_a"));
    writeFileSync(kept, line("s-kept", "req_b"));

    temp = new TempDatabase();
    const store = new LogStore(temp.openDatabase());
    const indexer = createLogIndexer({
      store,
      host: new LocalHostClient(),
      roots: [join(dir, ".claude", "projects")],
      log: silent,
    });

    await indexer.runOnce({ maxBytes: 20_000_000 });
    expect(store.getLogFile(doomed)).not.toBeNull();
    expect(store.listLogTurns({ ...all, providerThreadId: "s-gone" })).toHaveLength(1);

    unlinkSync(doomed);
    await indexer.runOnce({ maxBytes: 20_000_000 });

    expect(store.getLogFile(doomed)).toBeNull();
    expect(store.listLogTurns({ ...all, providerThreadId: "s-gone" })).toHaveLength(0);
    // The surviving file is untouched: a prune must not be a wipe.
    expect(store.getLogFile(kept)).not.toBeNull();
    expect(store.listLogTurns({ ...all, providerThreadId: "s-kept" })).toHaveLength(1);
    expect(Object.keys(store.cursors())).toEqual([kept]);
  });
});
