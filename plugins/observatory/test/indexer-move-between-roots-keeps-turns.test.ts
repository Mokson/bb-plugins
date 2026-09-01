// Codex ARCHIVES a finished rollout: the file moves from
// `~/.codex/sessions` to `~/.codex/archived_sessions`, and both are scanned.
// One pass therefore sees the same session under a new path and the old path
// as vanished, in that order, and the prune must not undo the index.
//
// Pruning by (provider, provider_thread_id) did exactly that: the delete for
// the departed path matched the rows the arrived path had just written, and
// every archived Codex session left the ledger the moment it was archived.
import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalHostClient } from "../src/core/host-client.js";
import { createLogIndexer } from "../src/core/indexer.js";
import { LogStore } from "../src/core/store-logs.js";
import { TempDatabase } from "./fakes.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const SESSION = "01a04c3e-bf33-7eb2-a447-a5efeef76eda";

function rollout(): string {
  return (
    `${JSON.stringify({
      timestamp: "2026-08-29T06:39:35.982Z",
      type: "session_meta",
      payload: { id: SESSION, cwd: "/redacted", model: "gpt-5.6-sol" },
    })}\n` +
    `${JSON.stringify({
      timestamp: "2026-08-29T06:47:06.996Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 141_707,
            cached_input_tokens: 139_008,
            output_tokens: 3_842,
            reasoning_output_tokens: 3_636,
          },
        },
      },
    })}\n`
  );
}

let temp: TempDatabase | null = null;
let dir = "";
afterEach(() => {
  temp?.dispose();
  temp = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("a session archived into a second scanned root", () => {
  it("keeps its turns when the old path is pruned in the same pass", async () => {
    dir = mkdtempSync(join(tmpdir(), "observatory-archive-"));
    const live = join(dir, ".codex", "sessions");
    const archived = join(dir, ".codex", "archived_sessions");
    mkdirSync(live, { recursive: true });
    mkdirSync(archived, { recursive: true });
    const before = join(live, "rollout-2026-08-29T07-39-35-01a04c3e.jsonl");
    const after = join(archived, "rollout-2026-08-29T07-39-35-01a04c3e.jsonl");
    writeFileSync(before, rollout());

    temp = new TempDatabase();
    const store = new LogStore(temp.openDatabase());
    const indexer = createLogIndexer({
      store,
      host: new LocalHostClient(),
      roots: [live, archived],
      log: silent,
    });

    const all = {
      provider: "codex",
      providerThreadId: SESSION,
      tsFrom: 0,
      tsTo: Number.MAX_SAFE_INTEGER,
    };
    await indexer.runOnce({ maxBytes: 20_000_000 });
    const indexed = store.listLogTurns(all);
    expect(indexed).toHaveLength(1);
    expect(indexed[0]!.path).toBe(before);

    renameSync(before, after);
    await indexer.runOnce({ maxBytes: 20_000_000 });

    // The row survived the move and now points at where the file actually is.
    const moved = store.listLogTurns(all);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.path).toBe(after);
    expect(moved[0]!.cache_read).toBe(139_008);
    // The departed path left no cursor behind, and the arrived one has one.
    expect(Object.keys(store.cursors())).toEqual([after]);
  });
});
