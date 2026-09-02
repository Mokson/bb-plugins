// The roots share one byte budget, and the order they are walked in decides
// who gets it.
//
// Walking them in list order meant `~/.claude/projects` - thousands of files,
// gigabytes - consumed every pass on its own and every later root was skipped
// for want of budget. After days of five-minute passes the live database held
// claude-code rows and nothing else: not a slow backlog, a permanent one.
// Taking one file from each root in turn is what makes every provider visible.
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalHostClient } from "../src/core/host-client.js";
import { createLogIndexer } from "../src/core/indexer.js";
import { LogStore } from "../src/core/store-logs.js";
import { TempDatabase } from "./fakes.js";

import { claudeAssistantLine, codexRollout } from "./synthetic-logs.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let temp: TempDatabase | null = null;
let dir = "";
afterEach(() => {
  temp?.dispose();
  temp = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("one pass over two roots", () => {
  it("indexes both even when the first root has far more work than the budget", async () => {
    dir = mkdtempSync(join(tmpdir(), "observatory-fair-"));
    const greedy = join(dir, ".claude", "projects");
    const later = join(dir, ".codex", "sessions");
    mkdirSync(join(greedy, "-p"), { recursive: true });
    mkdirSync(later, { recursive: true });

    // Forty files, each of them alone bigger than the whole budget, and each
    // made of complete lines so reading one really does spend the budget
    // rather than stopping at an unterminated tail.
    for (let index = 0; index < 40; index += 1) {
      let body = "";
      for (let entry = 0; entry < 200; entry += 1) {
        body += claudeAssistantLine(`s-${index}`, `req_${entry}`);
      }
      writeFileSync(join(greedy, "-p", `s-${index}.jsonl`), body);
    }
    writeFileSync(join(later, "rollout-x.jsonl"), codexRollout("codex-session"));

    temp = new TempDatabase();
    const store = new LogStore(temp.openDatabase());
    const indexer = createLogIndexer({
      store,
      host: new LocalHostClient(),
      roots: [greedy, later],
      log: silent,
    });

    const result = await indexer.runOnce({ maxBytes: 50_000 });

    // The budget could not cover the first root, so this is a real contest.
    expect(result.done).toBe(false);

    // Both roots produced turns in the SAME pass. In list order the second
    // root is never reached at all: the first root's first file spends the
    // whole budget and every file after it, in every root, is skipped.
    const providers = new Set(
      store.listUnmatchedSince(0, 100_000).map((row) => row.provider),
    );
    expect([...providers].sort()).toEqual(["claude-code", "codex"]);
    expect(
      store.listLogTurns({
        tsFrom: 0,
        tsTo: Number.MAX_SAFE_INTEGER,
        provider: "codex",
        providerThreadId: "codex-session",
      }),
    ).toHaveLength(1);
  });
});
