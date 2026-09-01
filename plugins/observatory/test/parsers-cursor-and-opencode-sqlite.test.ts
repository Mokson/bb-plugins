import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { scanCursorDatabase, cursorParser } from "../src/core/parsers/cursor.js";
import { scanOpencodeDatabase, isOpencodeStore, opencodeParser } from "../src/core/parsers/opencode.js";

// The fixture stores are BUILT here from the real schemas (captured with
// `sqlite3 .schema` against this machine's own stores) rather than copied,
// so no user conversation ever enters the repository.
const dir = mkdtempSync(join(tmpdir(), "observatory-sqlite-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const sessionDir = join(dir, ".cursor", "acp-sessions", "0cb8be45-1111-2222-3333-444455556666");
const cursorPath = join(sessionDir, "store.db");
const opencodePath = join(dir, "opencode.db");

function buildCursorStore() {
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(sessionDir, { recursive: true });
  const db = new Database(cursorPath);
  db.exec("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)");
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  const meta = JSON.stringify({
    agentId: "agent-7",
    name: "a session",
    createdAt: 1_788_001_057_610,
  });
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
    "0",
    Buffer.from(meta, "utf8").toString("hex"),
  );
  db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(
    "h1",
    Buffer.from(JSON.stringify({ role: "assistant", content: "prose" }), "utf8"),
  );
  db.close();
}

function buildOpencodeStore() {
  const db = new Database(opencodePath);
  db.exec(
    "CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, " +
      "time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)",
  );
  const insert = db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run("msg_1", "ses_a", 1_787_000_000_000, 1_787_000_009_000, JSON.stringify({
    role: "assistant",
    modelID: "claude-opus-5",
    providerID: "github-copilot",
    cost: 0.015997125,
    time: { completed: 1_787_000_009_500 },
    tokens: { input: 900, output: 300, reasoning: 40, total: 12_240, cache: { read: 11_000, write: 40 } },
  }));
  // In-flight: inserted at call start with no usage yet. Must not be billed.
  insert.run("msg_2", "ses_a", 1_787_000_010_000, 1_787_000_010_000, JSON.stringify({
    role: "assistant",
    modelID: "claude-opus-5",
    providerID: "github-copilot",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }));
  insert.run("msg_3", "ses_a", 1_787_000_011_000, 1_787_000_011_000, JSON.stringify({
    role: "user",
    tokens: { total: 5, cache: { read: 0, write: 0 } },
  }));
  db.close();
}

let built = true;
let reason = "";
try {
  buildCursorStore();
  buildOpencodeStore();
} catch (error) {
  built = false;
  reason = error instanceof Error ? error.message : String(error);
}

describe.skipIf(!built)("the SQLite-backed providers", () => {
  it("record a Cursor session as presence only, because Cursor logs no usage", () => {
    // Verified against this machine: the whole store.db schema is `blobs` and
    // `meta`. There are no token counts, no cost and no model anywhere in it.
    // The community scanner fills that hole with a chars/3.6 estimate; storing
    // an estimate in the same column as a measurement is how a made-up dollar
    // figure reaches the cost page.
    const rows = scanCursorDatabase(cursorPath);

    expect(rows).toHaveLength(1);
    expect(rows[0].providerThreadId).toBe("0cb8be45-1111-2222-3333-444455556666");
    expect(rows[0].agentId).toBe("agent-7");
    // The real createdAt, decoded out of the hex-encoded meta row.
    expect(rows[0].ts).toBe(1_788_001_057_610);
    expect(rows[0].input).toBe(0);
    expect(rows[0].output).toBe(0);
    expect(rows[0].cacheRead).toBeNull();
    expect(rows[0].cacheWrite).toBeNull();
    expect(rows[0].model).toBeNull();
    expect(cursorParser.matches(cursorPath)).toBe(true);
  });

  it("read OpenCode's split, its model, its upstream provider and its own cost", () => {
    const rows = scanOpencodeDatabase(opencodePath);

    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.providerThreadId).toBe("ses_a");
    // `$.time.completed`, not `time_created`: the row is inserted at request
    // time and updated when the call finishes.
    expect(row.ts).toBe(1_787_000_009_500);
    expect(row.model).toBe("github-copilot/claude-opus-5");
    expect(row.cacheRead).toBe(11_000);
    expect(row.cacheWrite).toBe(40);
    expect(row.loggedCostUsd).toBeCloseTo(0.015997125, 9);
  });

  it("skip the stale `opencode-next.db` that sits beside the real store", () => {
    expect(isOpencodeStore("/x/opencode.db")).toBe(true);
    expect(isOpencodeStore("/x/opencode-next.db")).toBe(false);
    expect(opencodeParser.matches("/x/opencode.db")).toBe(true);
  });
});

if (!built) {
  // eslint-disable-next-line no-console
  console.warn(`sqlite fixture stores could not be built, tests skipped: ${reason}`);
}
