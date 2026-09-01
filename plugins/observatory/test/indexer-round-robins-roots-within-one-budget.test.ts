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

const silent = { info: () => {}, warn: () => {}, error: () => {} };

function claudeLine(session: string, requestId: string) {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-01T00:00:00.000Z",
    sessionId: session,
    requestId,
    message: {
      model: "claude-opus-5",
      usage: {
        input_tokens: 1,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
        output_tokens: 4,
      },
    },
  })}\n`;
}

function rollout(session: string) {
  return (
    `${JSON.stringify({
      timestamp: "2026-08-29T06:39:35.982Z",
      type: "session_meta",
      payload: { id: session, cwd: "/redacted", model: "gpt-5.6-sol" },
    })}\n` +
    `${JSON.stringify({
      timestamp: "2026-08-29T06:47:06.996Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 90,
            output_tokens: 10,
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

describe("one pass over two roots", () => {
  it("indexes both even when the first root has far more work than the budget", async () => {
    dir = mkdtempSync(join(tmpdir(), "observatory-fair-"));
    const greedy = join(dir, ".claude", "projects");
    const later = join(dir, ".codex", "sessions");
    mkdirSync(join(greedy, "-p"), { recursive: true });
    mkdirSync(later, { recursive: true });

    // Forty files, each an order of magnitude bigger than the whole budget:
    // a pass that works through this root in order can never leave it.
    const filler = "x".repeat(200_000);
    for (let index = 0; index < 40; index += 1) {
      writeFileSync(
        join(greedy, "-p", `s-${index}.jsonl`),
        claudeLine(`s-${index}`, "req_a") +
          `${JSON.stringify({ type: "user", pad: filler })}\n`,
      );
    }
    writeFileSync(join(later, "rollout-x.jsonl"), rollout("codex-session"));

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
    const window = { tsFrom: 0, tsTo: Number.MAX_SAFE_INTEGER };
    // Both roots produced turns in the SAME pass.
    expect(
      store.listLogTurns({
        ...window,
        provider: "claude-code",
        providerThreadId: "s-0",
      }),
    ).toHaveLength(1);
    expect(
      store.listLogTurns({
        ...window,
        provider: "codex",
        providerThreadId: "codex-session",
      }),
    ).toHaveLength(1);
  });
});
