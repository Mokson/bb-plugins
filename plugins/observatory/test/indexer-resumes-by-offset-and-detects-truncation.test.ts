import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalHostClient } from "../src/core/host-client.js";
import { createLogIndexer } from "../src/core/indexer.js";
import { LogStore } from "../src/core/store-logs.js";
import { TempDatabase } from "./fakes.js";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

let temp: TempDatabase | null = null;
let dir = "";
afterEach(() => {
  temp?.dispose();
  temp = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function turn(session: string, requestId: string, read: number) {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-09-01T00:00:00.000Z",
    sessionId: session,
    requestId,
    message: {
      model: "claude-opus-5",
      usage: {
        input_tokens: 5,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: 10,
        output_tokens: 7,
      },
    },
  })}\n`;
}

function harness() {
  dir = mkdtempSync(join(tmpdir(), "observatory-indexer-"));
  const root = join(dir, ".claude", "projects", "-p");
  mkdirSync(root, { recursive: true });
  const file = join(root, "s1.jsonl");
  temp = new TempDatabase();
  const store = new LogStore(temp.openDatabase());
  const indexer = createLogIndexer({
    store,
    host: new LocalHostClient(),
    roots: [join(dir, ".claude", "projects")],
    log: silent,
  });
  return { store, indexer, file };
}

// A five-minute sweep over thousands of session files only works if an
// unchanged file costs nothing and a growing one is read from where it left
// off. The dangerous half is the other direction: a file rewritten in place
// looks exactly like a file appended to, and resuming past the rewrite would
// leave rows describing a session that no longer exists.
describe("the log indexer", () => {
  it("resumes at the stored byte offset and reparses nothing", async () => {
    const { store, indexer, file } = harness();
    writeFileSync(file, turn("s1", "req_a", 100));

    const first = await indexer.runOnce({ maxBytes: 20_000_000 });
    expect(first.rows).toBe(1);
    const afterFirst = store.getLogFile(file)!;
    expect(afterFirst.indexed_bytes).toBe(afterFirst.size_bytes);
    expect(afterFirst.indexed_lines).toBe(1);

    // Nothing changed: the pass must not re-read the file at all.
    const idle = await indexer.runOnce({ maxBytes: 20_000_000 });
    expect(idle.files).toBe(0);
    expect(idle.rows).toBe(0);

    appendFileSync(file, turn("s1", "req_b", 200));
    const second = await indexer.runOnce({ maxBytes: 20_000_000 });

    // Only the appended request came back, not both.
    expect(second.rows).toBe(1);
    const afterSecond = store.getLogFile(file)!;
    expect(afterSecond.indexed_lines).toBe(2);
    expect(afterSecond.indexed_bytes).toBe(afterSecond.size_bytes);
    expect(
      store.listLogTurns({
        provider: "claude-code",
        providerThreadId: "s1",
        tsFrom: 0,
        tsTo: Number.MAX_SAFE_INTEGER,
      }),
    ).toHaveLength(2);
  });

  it("reparses from zero when the file was truncated", async () => {
    const { store, indexer, file } = harness();
    writeFileSync(file, turn("s1", "req_a", 100) + turn("s1", "req_b", 200));
    await indexer.runOnce({ maxBytes: 20_000_000 });

    writeFileSync(file, turn("s1", "req_c", 300));
    const result = await indexer.runOnce({ maxBytes: 20_000_000 });

    expect(result.rows).toBe(1);
    const file_ = store.getLogFile(file)!;
    expect(file_.indexed_bytes).toBe(file_.size_bytes);
    expect(file_.indexed_lines).toBe(1);
  });

  it("reparses from zero when the file was rewritten in place at the same length", async () => {
    const { store, indexer, file } = harness();
    writeFileSync(file, turn("s1", "req_a", 100));
    await indexer.runOnce({ maxBytes: 20_000_000 });
    const size = store.getLogFile(file)!.size_bytes;

    // Same byte length, different content: the head fingerprint is what
    // catches this. A byte offset alone would call it an append.
    writeFileSync(file, turn("s2", "req_a", 100));
    expect(store.getLogFile(file)!.size_bytes).toBe(size);

    const result = await indexer.runOnce({ maxBytes: 20_000_000 });

    expect(result.rows).toBe(1);
    expect(store.getLogFile(file)!.provider_thread_id).toBe("s2");
  });

  it("stops the cursor at the last complete line, so a half-written tail is retried", async () => {
    const { store, indexer, file } = harness();
    const complete = turn("s1", "req_a", 100);
    writeFileSync(file, complete + '{"type":"assistant","timesta');

    const first = await indexer.runOnce({ maxBytes: 20_000_000 });

    expect(first.rows).toBe(1);
    expect(store.getLogFile(file)!.indexed_bytes).toBe(complete.length);

    // The writer finishes the line; the retry picks it up whole.
    writeFileSync(file, complete + turn("s1", "req_b", 200));
    const second = await indexer.runOnce({ maxBytes: 20_000_000 });
    expect(second.rows).toBe(1);
  });

  it("consumes a final line that has no trailing newline, so the cursor can finish", async () => {
    // Found against real data: plenty of finished session files end without a
    // newline. Leaving that line unconsumed pins the cursor short of the file
    // size forever, and every sweep re-reads and re-upserts the whole file.
    const { store, indexer, file } = harness();
    writeFileSync(file, turn("s1", "req_a", 100) + turn("s1", "req_b", 200).trimEnd());

    const first = await indexer.runOnce({ maxBytes: 20_000_000 });
    expect(first.rows).toBe(2);
    const indexed = store.getLogFile(file)!;
    expect(indexed.indexed_bytes).toBe(indexed.size_bytes);

    const idle = await indexer.runOnce({ maxBytes: 20_000_000 });
    expect(idle.files).toBe(0);
    expect(idle.rows).toBe(0);
  });

  it("reports `done: false` when the byte budget runs out before the roots do", async () => {
    const { indexer, file } = harness();
    writeFileSync(file, turn("s1", "req_a", 100).repeat(40));

    const result = await indexer.runOnce({ maxBytes: 200 });

    expect(result.done).toBe(false);
  });
});
