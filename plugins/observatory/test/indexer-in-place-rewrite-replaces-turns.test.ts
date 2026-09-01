// A log rewritten in place is not a log appended to.
//
// The host already proves this: it fingerprints the indexed prefix, and a
// mismatch sets `reset`, meaning "reparsed from byte zero". The indexer was
// computing that flag and then ignoring it, so the rows from the OLD content
// stayed in the table beside the rows from the new content and the session was
// billed twice. A reset has to be a REPLACEMENT.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

describe("a log file rewritten in place", () => {
  it("replaces its turns instead of accumulating a second copy", async () => {
    dir = mkdtempSync(join(tmpdir(), "observatory-rewrite-"));
    const root = join(dir, ".claude", "projects", "-p");
    mkdirSync(root, { recursive: true });
    const path = join(root, "session.jsonl");
    writeFileSync(path, line("s-1", "req_a", 4) + line("s-1", "req_b", 5));

    temp = new TempDatabase();
    const store = new LogStore(temp.openDatabase());
    const indexer = createLogIndexer({
      store,
      host: new LocalHostClient(),
      roots: [join(dir, ".claude", "projects")],
      log: silent,
    });
    const all = {
      provider: "claude-code",
      providerThreadId: "s-1",
      tsFrom: 0,
      tsTo: Number.MAX_SAFE_INTEGER,
    };

    await indexer.runOnce({ maxBytes: 20_000_000 });
    expect(store.listLogTurns(all).map((row) => row.log_key).sort()).toEqual([
      "claude-code:s-1:req_a",
      "claude-code:s-1:req_b",
    ]);

    // Same file, entirely different content, and long enough that it does not
    // shrink: only the head fingerprint can tell this from an append.
    writeFileSync(
      path,
      line("s-1", "req_x", 40) +
        line("s-1", "req_y", 50) +
        line("s-1", "req_z", 60),
    );
    await indexer.runOnce({ maxBytes: 20_000_000 });

    const after = store.listLogTurns(all);
    expect(after.map((row) => row.log_key).sort()).toEqual([
      "claude-code:s-1:req_x",
      "claude-code:s-1:req_y",
      "claude-code:s-1:req_z",
    ]);
    // The point of the invariant: nothing from the old content is still billed.
    expect(after.reduce((sum, row) => sum + row.output, 0)).toBe(150);
  });
});
