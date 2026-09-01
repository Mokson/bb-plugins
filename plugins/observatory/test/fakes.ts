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

// ---------------------------------------------------------------------------
// Watch fixtures: a real database seeded with the ledger rows the rules read.
//
// The rules are pure over a snapshot, so a rule test could skip sqlite
// entirely — but then nothing would prove the SQL that BUILDS the snapshot
// selects the rows the rules assume. These fixtures write real rows and let
// `WatchQueries` do the reading, so a column rename fails a rule test.
// ---------------------------------------------------------------------------

import { createWatchRuntime, type WatchRuntime } from "../src/watch/module.js";

/** A fixed instant so every fixture's arithmetic is readable. */
export const T0 = Date.parse("2026-09-01T12:00:00.000Z");

export function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

export interface SeedItem {
  seq: number;
  kind: string;
  name?: string;
  path?: string | null;
  fingerprint?: string | null;
  /** Offset from T0 in ms; negative is in the past. */
  startedAt: number;
  /** Omit to leave the item in flight. */
  completedAt?: number;
  turnId?: string;
}

export interface SeedTurn {
  turnId: string;
  seqStarted: number;
  startedAt: number;
  completedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  compacted?: boolean;
  errorCategory?: string;
  willRetry?: boolean;
}

export interface WatchFixture {
  host: FakePluginHost;
  runtime: WatchRuntime;
  store: ObservatoryStore;
  db: Database.Database;
  /** Mutable; a test edits it then calls `runtime.refresh()`. */
  settingValues: Record<string, string | boolean | undefined>;
  /** Every `bb.realtime.publish` the ladder made. */
  published(): Array<{ channel: string; payload: unknown }>;
  seedThread(options?: {
    threadId?: string;
    title?: string;
    seat?: string | null;
    status?: string;
    rootThreadId?: string;
  }): string;
  seedTurns(threadId: string, turns: readonly SeedTurn[]): void;
  seedItems(threadId: string, items: readonly SeedItem[]): void;
  dispose(): void;
}

/**
 * A watch runtime over a fake host with a frozen clock. `clock.now` is read
 * per call, so a test advances time by assigning to it.
 */
export function makeWatchFixture(
  settingValues: Record<string, string | boolean | undefined> = {},
  clock: { now: number } = { now: T0 },
): WatchFixture {
  const host = createFakePluginHost({ pluginId: "observatory" });
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, MIGRATIONS);
  const store = new ObservatoryStore(db);
  const runtime = createWatchRuntime({
    bb: host.bb,
    db,
    settings: async () => settingValues,
    now: () => clock.now,
  });

  return {
    host,
    runtime,
    store,
    db,
    settingValues,
    published: () => host.harness.inspection.realtimeSignals,
    seedThread(options = {}) {
      const threadId = options.threadId ?? "thr-watch";
      store.upsertThread({
        thread_id: threadId,
        title: options.title ?? "[obs-test] loop",
        seat: options.seat ?? null,
        status: options.status ?? "active",
        root_thread_id: options.rootThreadId ?? threadId,
        depth: 0,
      });
      return threadId;
    },
    seedTurns(threadId, turns) {
      for (const turn of turns) {
        store.upsertTurn({
          thread_id: threadId,
          turn_id: turn.turnId,
          root_thread_id: threadId,
          seq_started: turn.seqStarted,
          started_at: iso(turn.startedAt),
          completed_at:
            turn.completedAt === undefined ? null : iso(turn.completedAt),
          input_tokens: turn.inputTokens ?? 0,
          output_tokens: turn.outputTokens ?? 0,
          cost_usd: turn.costUsd ?? 0,
          compacted: turn.compacted ? 1 : 0,
          error_category: turn.errorCategory ?? null,
          will_retry: turn.willRetry ? 1 : 0,
        });
      }
    },
    seedItems(threadId, items) {
      for (const item of items) {
        store.upsertItem({
          item_id: `item-${threadId}-${item.seq}`,
          thread_id: threadId,
          turn_id: item.turnId ?? "turn-1",
          seq: item.seq,
          kind: item.kind,
          name: item.name ?? item.kind,
          status: item.completedAt === undefined ? "pending" : "completed",
          started_at: iso(item.startedAt),
          completed_at:
            item.completedAt === undefined ? null : iso(item.completedAt),
          path: item.path ?? null,
          input_fingerprint: item.fingerprint ?? null,
        });
      }
    },
    dispose() {
      db.close();
    },
  };
}

/**
 * The healthy control every rule test asserts against: an active thread with
 * a turn in flight, a tool call running, and a file change moments ago.
 */
export function seedHealthyThread(fixture: WatchFixture): string {
  const threadId = fixture.seedThread({ threadId: "thr-healthy" });
  fixture.seedTurns(threadId, [
    { turnId: "turn-1", seqStarted: 1, startedAt: -30_000 },
  ]);
  fixture.seedItems(threadId, [
    {
      seq: 2,
      kind: "fileChange",
      path: "src/a.ts",
      startedAt: -20_000,
      completedAt: -19_000,
    },
    {
      seq: 3,
      kind: "toolCall",
      name: "Bash",
      fingerprint: "fp-unique",
      startedAt: -5_000,
    },
  ]);
  return threadId;
}
