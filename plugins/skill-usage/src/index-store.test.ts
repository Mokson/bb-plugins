import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearIndex,
  indexedThreadCount,
  loadRollup,
  MIGRATIONS,
  pruneThreads,
  readCursor,
  readSessions,
  recordSessions,
  sessionLogUnchanged,
  writeCommands,
  writeThread,
  type SqliteDatabase,
} from "./index-store";
import type { SkillInvocation } from "./model";

function invocation(overrides: Partial<SkillInvocation> & { itemId: string }): SkillInvocation {
  return {
    threadId: "t1",
    seq: 1,
    createdAt: 100,
    skill: "grilling",
    args: null,
    status: "completed",
    result: null,
    source: "tool",
    ...overrides,
  };
}

let db: SqliteDatabase;

beforeEach(() => {
  // In-memory, so every test starts from the real schema with no fixture file.
  const handle = new Database(":memory:");
  for (const statement of MIGRATIONS) handle.exec(statement);
  db = handle as unknown as SqliteDatabase;
});

describe("cursors", () => {
  it("starts at zero for an unseen thread", () => {
    expect(readCursor(db, "t1")).toBe(0);
  });

  it("advances after a write and survives a second pass", () => {
    writeThread(db, { threadId: "t1", projectId: "p1", invocations: [], lastSeq: 42 });
    expect(readCursor(db, "t1")).toBe(42);
    writeThread(db, { threadId: "t1", projectId: "p1", invocations: [], lastSeq: 90 });
    expect(readCursor(db, "t1")).toBe(90);
  });
});

describe("writeThread", () => {
  it("upserts, so re-walking a range does not double count", () => {
    const rows = [invocation({ itemId: "a" }), invocation({ itemId: "b", skill: "pr" })];
    writeThread(db, { threadId: "t1", projectId: "p1", invocations: rows, lastSeq: 5 });
    writeThread(db, { threadId: "t1", projectId: "p1", invocations: rows, lastSeq: 5 });
    expect(loadRollup(db, null).reduce((sum, row) => sum + row.total, 0)).toBe(2);
  });

  it("overwrites a running invocation with its terminal status", () => {
    writeThread(db, {
      threadId: "t1",
      projectId: "p1",
      invocations: [invocation({ itemId: "a", status: "running" })],
      lastSeq: 1,
    });
    writeThread(db, {
      threadId: "t1",
      projectId: "p1",
      invocations: [invocation({ itemId: "a", status: "failed" })],
      lastSeq: 2,
    });
    expect(loadRollup(db, null)[0]).toMatchObject({ total: 1, failures: 1 });
  });
});

describe("loadRollup", () => {
  beforeEach(() => {
    writeThread(db, {
      threadId: "t1",
      projectId: "p1",
      invocations: [invocation({ itemId: "a" }), invocation({ itemId: "b", skill: "pr" })],
      lastSeq: 2,
    });
    writeThread(db, {
      threadId: "t2",
      projectId: "p2",
      invocations: [invocation({ itemId: "c", threadId: "t2", skill: "pr" })],
      lastSeq: 1,
    });
  });

  it("scopes to one project", () => {
    expect(loadRollup(db, "p2").map((row) => row.skill)).toEqual(["pr"]);
    expect(loadRollup(db, "p2")[0]?.total).toBe(1);
  });

  it("spans every project when asked globally", () => {
    const rows = loadRollup(db, null);
    expect(rows[0]).toMatchObject({ skill: "pr", total: 2 });
    expect(rows[0]?.threads).toHaveLength(2);
  });

  it("counts indexed threads", () => {
    expect(indexedThreadCount(db)).toBe(2);
  });
});

describe("pruneThreads", () => {
  beforeEach(() => {
    writeThread(db, {
      threadId: "t1",
      projectId: "p1",
      invocations: [invocation({ itemId: "a" })],
      lastSeq: 1,
    });
    writeThread(db, {
      threadId: "gone",
      projectId: "p1",
      invocations: [invocation({ itemId: "b", threadId: "gone" })],
      lastSeq: 1,
    });
  });

  it("drops rows and cursors for threads that no longer exist", () => {
    expect(pruneThreads(db, new Set(["t1"]))).toBe(1);
    expect(indexedThreadCount(db)).toBe(1);
    expect(readCursor(db, "gone")).toBe(0);
  });

  it("keeps everything when every thread is still live", () => {
    expect(pruneThreads(db, new Set(["t1", "gone"]))).toBe(0);
    expect(indexedThreadCount(db)).toBe(2);
  });
});

describe("clearIndex", () => {
  it("empties rows and cursors so the next pass rebuilds", () => {
    writeThread(db, {
      threadId: "t1",
      projectId: "p1",
      invocations: [invocation({ itemId: "a" })],
      lastSeq: 7,
    });
    clearIndex(db);
    expect(indexedThreadCount(db)).toBe(0);
    expect(readCursor(db, "t1")).toBe(0);
    expect(loadRollup(db, null)).toEqual([]);
  });
});

describe("command rows from session logs", () => {
  const file = { path: "/logs/a.jsonl", mtimeMs: 10, sizeBytes: 100 };

  it("remembers provider sessions across passes", () => {
    recordSessions(db, "t1", new Set(["s1", "s2"]));
    recordSessions(db, "t1", new Set(["s1"]));
    expect([...readSessions(db, "t1")].sort()).toEqual(["s1", "s2"]);
  });

  it("skips a log that has not changed since it was parsed", () => {
    expect(sessionLogUnchanged(db, "t1", file)).toBe(false);
    writeCommands(db, { threadId: "t1", projectId: "p1", file, invocations: [] });
    expect(sessionLogUnchanged(db, "t1", file)).toBe(true);
    expect(sessionLogUnchanged(db, "t1", { ...file, sizeBytes: 200 })).toBe(false);
  });

  it("replaces only its own file's rows when a log is re-read", () => {
    const other = { path: "/logs/b.jsonl", mtimeMs: 10, sizeBytes: 100 };
    writeCommands(db, {
      threadId: "t1",
      projectId: "p1",
      file,
      invocations: [invocation({ itemId: "a", skill: "pr", source: "command" })],
    });
    writeCommands(db, {
      threadId: "t1",
      projectId: "p1",
      file: other,
      invocations: [invocation({ itemId: "b", skill: "qa", source: "command" })],
    });
    writeCommands(db, {
      threadId: "t1",
      projectId: "p1",
      file,
      invocations: [invocation({ itemId: "c", skill: "debug", source: "command" })],
    });
    expect(loadRollup(db, null).map((row) => row.skill).sort()).toEqual(["debug", "qa"]);
  });

  it("keeps tool rows when a log is re-read, since they carry no file", () => {
    writeThread(db, {
      threadId: "t1",
      projectId: "p1",
      invocations: [invocation({ itemId: "tool-a" })],
      lastSeq: 1,
    });
    writeCommands(db, { threadId: "t1", projectId: "p1", file, invocations: [] });
    expect(loadRollup(db, null)).toHaveLength(1);
  });

  it("round-trips the source through the index", () => {
    writeCommands(db, {
      threadId: "t1",
      projectId: "p1",
      file,
      invocations: [invocation({ itemId: "a", source: "command" })],
    });
    expect(loadRollup(db, null)[0]?.total).toBe(1);
  });

  it("prunes session state with the thread", () => {
    writeCommands(db, {
      threadId: "gone",
      projectId: "p1",
      file,
      invocations: [invocation({ itemId: "a", threadId: "gone", source: "command" })],
    });
    writeThread(db, { threadId: "gone", projectId: "p1", invocations: [], lastSeq: 1 });
    recordSessions(db, "gone", new Set(["s1"]));
    pruneThreads(db, new Set(["t1"]));
    expect(readSessions(db, "gone").size).toBe(0);
    expect(sessionLogUnchanged(db, "gone", file)).toBe(false);
    expect(loadRollup(db, null)).toEqual([]);
  });
});
