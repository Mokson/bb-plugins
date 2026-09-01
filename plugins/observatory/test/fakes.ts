// Shared test doubles. Every backend test runs against the SDK's own fake
// plugin host, so `bb` here is the same `BbPluginApi` the server compiles
// against and its storage is a real sqlite file in a temp directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  createFakePluginHost,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { MIGRATIONS, ObservatoryStore } from "../src/core/store.js";
import { ModuleRegistry } from "../src/module.js";

/** A file-backed store whose handle can be closed and reopened. */
export class TempDatabase {
  readonly dir: string;
  readonly path: string;
  private handle: Database.Database | null = null;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "observatory-test-"));
    this.path = join(this.dir, "data.db");
  }

  openDatabase(): Database.Database {
    this.close();
    const db = new Database(this.path);
    applyTestMigrations(db);
    this.handle = db;
    return db;
  }

  open(): ObservatoryStore {
    return new ObservatoryStore(this.openDatabase());
  }

  close(): void {
    this.handle?.close();
    this.handle = null;
  }

  dispose(): void {
    this.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * The host's migration semantics, reimplemented for tests that hold a raw
 * database rather than a fake host: index is the migration id, and an applied
 * index is skipped.
 */
export function applyTestMigrations(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    db
      .prepare<[], { id: number }>("SELECT id FROM _bb_migrations")
      .all()
      .map((row) => row.id),
  );
  const insert = db.prepare(
    "INSERT INTO _bb_migrations (id, applied_at) VALUES (?, ?)",
  );
  db.transaction(() => {
    MIGRATIONS.forEach((statement, index) => {
      if (applied.has(index)) return;
      db.exec(statement);
      insert.run(index, Date.now());
    });
  })();
}

export interface FakeHarness extends FakePluginHost {
  store: ObservatoryStore;
  registry: ModuleRegistry;
  settings(): Promise<Record<string, string | boolean | undefined>>;
}

/**
 * A fake host with the schema applied and a registry wired to it. `settings`
 * is a plain map the test controls, standing in for `bb.settings.define`.
 */
export function makeHarness(
  settingValues: Record<string, string | boolean | undefined> = {},
): FakeHarness {
  const host = createFakePluginHost({ pluginId: "observatory" });
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, MIGRATIONS);
  const store = new ObservatoryStore(db);
  const settings = async () => settingValues;
  const registry = new ModuleRegistry({
    bb: host.bb,
    db: () => db,
    settings,
  });
  return { ...host, store, registry, settings };
}

// ---------------------------------------------------------------------------
// Core ingest doubles: hand-built thread events, a fake threads area, and a
// `bb` stub with just the surfaces core touches. Kept structural rather than
// mocked so the tests fail when the SDK shape moves.
// ---------------------------------------------------------------------------

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ThreadEventRow } from "../src/core/events.js";

export interface EventOptions {
  turnId?: string;
  createdAt?: number;
}

/** One stored thread event, shaped like `provider-event.ts` produces. */
export function event(
  seq: number,
  type: string,
  data: Record<string, unknown>,
  options: EventOptions = {},
): ThreadEventRow {
  return {
    id: `evt-${seq}`,
    threadId: "thr-1",
    seq,
    createdAt: options.createdAt ?? 1_700_000_000_000 + seq * 1_000,
    scope: options.turnId
      ? { kind: "turn", turnId: options.turnId }
      : { kind: "thread" },
    type,
    data,
  } as unknown as ThreadEventRow;
}

export function tokenUsage(
  seq: number,
  totals: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
  },
  options: EventOptions = {},
): ThreadEventRow {
  const breakdown = {
    ...totals,
    totalTokens:
      totals.inputTokens + totals.cachedInputTokens + totals.outputTokens,
  };
  return event(
    seq,
    "thread/tokenUsage/updated",
    {
      providerThreadId: "sess-1",
      tokenUsage: {
        total: breakdown,
        last: breakdown,
        modelContextWindow: 200_000,
      },
    },
    options,
  );
}

export interface FakeThreadDto {
  id: string;
  projectId?: string;
  providerId?: string;
  title?: string | null;
  titleFallback?: string | null;
  parentThreadId?: string | null;
  visibility?: string;
  originKind?: string | null;
  status?: string;
  createdAt?: number;
  environment?: { path: string | null } | null;
}

export interface FakeIngestHost {
  bb: BbPluginApi;
  /** Pages served by `events.list`, keyed by thread. */
  pages: Map<string, ThreadEventRow[]>;
  threads: Map<string, FakeThreadDto>;
  /** Every `events.list` call, for asserting the watermark is honoured. */
  listCalls: Array<{ threadId: string; afterSeq?: string }>;
  /** Fires the realtime callback the ingest loop registered. */
  emitChanged(message: {
    id: string;
    changes?: string[];
    metadata?: { eventTypes?: string[] };
  }): void;
}

/**
 * A `bb` stub carrying only what core reads: the threads area, the realtime
 * subscription, lifecycle events and the logger.
 */
export function makeIngestHost(): FakeIngestHost {
  const pages = new Map<string, ThreadEventRow[]>();
  const threads = new Map<string, FakeThreadDto>();
  const listCalls: FakeIngestHost["listCalls"] = [];
  let changedCallback: ((message: unknown) => void) | null = null;

  const bb = {
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    events: { on: () => {} },
    sdk: {
      subscribe: (args: { callback: (message: unknown) => void }) => {
        changedCallback = args.callback;
        return () => {
          changedCallback = null;
        };
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const dto = threads.get(threadId);
          if (!dto) throw new Error(`unknown thread ${threadId}`);
          return {
            projectId: "proj-1",
            providerId: "claude-code",
            title: null,
            titleFallback: null,
            parentThreadId: null,
            visibility: "visible",
            originKind: null,
            status: "idle",
            createdAt: 1_700_000_000_000,
            environment: null,
            ...dto,
          };
        },
        list: async () => [...threads.values()],
        events: {
          list: async (args: { threadId: string; afterSeq?: string }) => {
            listCalls.push({ threadId: args.threadId, afterSeq: args.afterSeq });
            const all = pages.get(args.threadId) ?? [];
            const after =
              args.afterSeq === undefined ? -1 : Number(args.afterSeq);
            return all.filter((row) => row.seq > after);
          },
        },
      },
    },
  } as unknown as BbPluginApi;

  return {
    bb,
    pages,
    threads,
    listCalls,
    emitChanged(message) {
      changedCallback?.({ changes: [], ...message });
    },
  };
}
