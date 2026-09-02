import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type CreateFakePluginHostOptions,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server";
import { betterSidebarRpcContract, DOSSIER_CHANNEL } from "./server-contract";

interface StoredEvent {
  type: string;
  seq: number;
  data: unknown;
}

/** One stored thread event row, shaped like `ThreadEventRow`. */
function event(type: string, seq: number, data: unknown): StoredEvent {
  return { type, seq, data };
}

const tokenUsage = (total: number) =>
  event("thread/tokenUsage/updated", 10, {
    providerThreadId: "p",
    tokenUsage: {
      last: {
        totalTokens: total,
        inputTokens: total,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      total: {
        totalTokens: total,
        inputTokens: total,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 200_000,
    },
  });

const contextWindowUsage = (usedTokens: number | null, window: number | null) =>
  event("thread/contextWindowUsage/updated", 11, {
    providerThreadId: "p",
    contextWindowUsage: { usedTokens, modelContextWindow: window, estimated: false },
  });

const modelFallback = (seq: number) =>
  event("provider/modelFallback", seq, {
    providerThreadId: "p",
    originalModel: "opus",
    fallbackModel: "sonnet",
    reason: "provider",
    message: "capacity",
  });

const rateLimits = (status: string) =>
  event("provider/rateLimits/updated", 13, {
    rateLimits: {
      kind: "subscription-window",
      overageReason: null,
      overageStatus: null,
      providerId: "anthropic",
      reachedReason: null,
      status,
      windows: [],
    },
  });

const goalUpdated = (seq: number) =>
  event("thread/goal/updated", seq, {
    providerThreadId: "p",
    objective: "ship it",
    status: "active",
    timeUsedSeconds: 1,
    tokenBudget: 50_000,
    tokensUsed: 1_000,
  });

const goalCleared = (seq: number) =>
  event("thread/goal/cleared", seq, { providerThreadId: "p" });

/**
 * A host whose `events.list` reproduces the server's filter semantics: filter
 * by `types`, order by `seq`, then apply `limit` to the *filtered* list. That
 * last step is what makes the combined-read regression observable.
 */
function hostWith(options: {
  events?: Record<string, StoredEvent[]>;
  execution?: unknown;
}): FakePluginHost {
  const byThread = options.events ?? {};
  const sdk: CreateFakePluginHostOptions["sdk"] = {
    threads: {
      defaultExecutionOptions: async () => options.execution ?? null,
      events: {
        list: async (args) => {
          const { threadId, types, order, limit } = args as {
            threadId: string;
            types?: readonly string[];
            order?: "asc" | "desc";
            limit?: string;
          };
          const rows = (byThread[threadId] ?? [])
            .filter((row) => !types || types.includes(row.type))
            .sort((a, b) => (order === "desc" ? b.seq - a.seq : a.seq - b.seq))
            .map((row) => ({
              id: `${row.type}:${row.seq}`,
              scope: "thread",
              threadId,
              seq: row.seq,
              createdAt: row.seq,
              type: row.type,
              data: row.data,
            }));
          return limit ? rows.slice(0, Number(limit)) : rows;
        },
      },
    },
  };
  return createFakePluginHost({ pluginId: "better-sidebar", sdk });
}

const listCalls = (host: FakePluginHost) =>
  host.harness.inspection.sdk.callsTo("threads.events.list").length;

describe("threadDossier", () => {
  it("returns economics: null for a thread with no token events, without throwing", async () => {
    const host = hostWith({
      events: { t1: [contextWindowUsage(1_000, 200_000)] },
      execution: { model: "opus", reasoningLevel: "high" },
    });
    await plugin(host.bb);

    const dossier = (await host.harness.callRpc("threadDossier", {
      threadId: "t1",
    })) as Record<string, unknown>;

    expect(dossier.economics).toBeNull();
    expect(dossier.execution).toEqual({ model: "opus", reasoningLevel: "high" });
    expect(dossier.contextWindow).toEqual({
      usedTokens: 1_000,
      modelContextWindow: 200_000,
      estimated: false,
    });
    expect(dossier.fetchedAt).toBeTypeOf("number");
  });

  it("returns execution: null when the thread never resolved execution options", async () => {
    const host = hostWith({ events: { t1: [tokenUsage(500)] }, execution: null });
    await plugin(host.bb);

    const dossier = (await host.harness.callRpc("threadDossier", {
      threadId: "t1",
    })) as Record<string, unknown>;

    expect(dossier.execution).toBeNull();
    expect(dossier.economics).toEqual({
      total: {
        totalTokens: 500,
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 200_000,
    });
  });

  // The backend does not cache (F9): the frontend caches both methods at the
  // same TTLs with in-flight dedup, and a second copy here only adds a second
  // invalidation surface. What the handler owes every caller is a correct
  // payload, so that — not a call count — is what this asserts.
  it("serves every repeat call the same payload, and picks up new data after a turn", async () => {
    const host = hostWith({ events: { t1: [tokenUsage(500)] } });
    await plugin(host.bb);

    const first = await host.harness.callRpc("threadDossier", { threadId: "t1" });
    const second = await host.harness.callRpc("threadDossier", { threadId: "t1" });
    expect((second as { economics: unknown }).economics).toEqual(
      (first as { economics: unknown }).economics,
    );

    await host.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "t1" }),
      lastAssistantText: null,
    });

    const third = (await host.harness.callRpc("threadDossier", {
      threadId: "t1",
    })) as { economics: { total: { totalTokens: number } } };
    expect(third.economics.total.totalTokens).toBe(500);
  });
});

describe("lifecycle invalidation (B28)", () => {
  it("publishes the dossier channel on idle and failed — the moments data lands", async () => {
    const host = hostWith({});
    await plugin(host.bb);

    const thread = makeThreadResponse({ id: "t1" });
    await host.harness.emitThreadEvent("thread.idle", { thread, lastAssistantText: null });
    await host.harness.emitThreadEvent("thread.failed", { thread, error: null });

    expect(host.harness.inspection.realtimeSignals).toEqual([
      { channel: DOSSIER_CHANNEL, payload: { threadId: "t1" } },
      { channel: DOSSIER_CHANNEL, payload: { threadId: "t1" } },
    ]);
  });

  // F8: `thread.active` fires at the START of a turn, before any new usage
  // event exists. Invalidating there refetches every visible row for no new
  // data, doubling the per-turn cost of the whole list.
  it("does not publish on thread.active, when no new usage data exists yet", async () => {
    const host = hostWith({});
    await plugin(host.bb);

    await host.harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "t1" }),
    });

    expect(host.harness.inspection.realtimeSignals).toEqual([]);
  });

  it("does not publish on thread.deleted: a deleted row has nothing to refresh", async () => {
    const host = hostWith({ events: { t1: [tokenUsage(500)] } });
    await plugin(host.bb);

    await host.harness.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "t1" }),
    });

    expect(host.harness.inspection.realtimeSignals).toEqual([]);
  });
});

describe("threadExecutions (B71.1)", () => {
  /** A host whose `defaultExecutionOptions` answers per thread id. */
  function hostWithExecutions(
    perThread: Record<string, unknown | (() => never)>,
  ): FakePluginHost {
    const sdk: CreateFakePluginHostOptions["sdk"] = {
      threads: {
        defaultExecutionOptions: async (args) => {
          const { threadId } = args as { threadId: string };
          const value = perThread[threadId];
          return typeof value === "function" ? value() : (value ?? null);
        },
        events: { list: async () => [] },
      },
    };
    return createFakePluginHost({ pluginId: "better-sidebar", sdk });
  }

  it("returns one entry per requested id, in the order asked for", async () => {
    const threadIds = Array.from({ length: 17 }, (_, index) => `t${index}`);
    const host = hostWithExecutions(
      Object.fromEntries(
        threadIds.map((id) => [id, { model: "opus", reasoningLevel: "high" }]),
      ),
    );
    await plugin(host.bb);

    const result = (await host.harness.callRpc("threadExecutions", {
      threadIds,
    })) as { executions: { threadId: string; execution: unknown }[] };

    expect(result.executions.map((entry) => entry.threadId)).toEqual(threadIds);
    expect(result.executions[0].execution).toEqual({
      model: "opus",
      reasoningLevel: "high",
    });
    // Seventeen children, one round trip. The fan-out is inside the handler.
    expect(
      host.harness.inspection.sdk.callsTo("threads.defaultExecutionOptions"),
    ).toHaveLength(17);
  });

  it("returns execution: null for a thread that never resolved options", async () => {
    const host = hostWithExecutions({ t1: null });
    await plugin(host.bb);

    const result = (await host.harness.callRpc("threadExecutions", {
      threadIds: ["t1"],
    })) as { executions: unknown[] };

    expect(result.executions).toEqual([{ threadId: "t1", execution: null }]);
  });

  it("folds a per-id failure into that id's null and keeps the batch", async () => {
    const host = hostWithExecutions({
      t1: { model: "opus", reasoningLevel: "high" },
      t2: () => {
        throw new Error("thread gone");
      },
      t3: { model: "sonnet", reasoningLevel: "low" },
    });
    await plugin(host.bb);

    const result = (await host.harness.callRpc("threadExecutions", {
      threadIds: ["t1", "t2", "t3"],
    })) as { executions: { threadId: string; execution: unknown }[] };

    expect(result.executions).toEqual([
      { threadId: "t1", execution: { model: "opus", reasoningLevel: "high" } },
      { threadId: "t2", execution: null },
      { threadId: "t3", execution: { model: "sonnet", reasoningLevel: "low" } },
    ]);
  });
});

describe("rowSignals", () => {
  it("issues exactly four events.list calls per requested thread, and one row each", async () => {
    const threadIds = Array.from({ length: 40 }, (_, index) => `t${index}`);
    const host = hostWith({});
    await plugin(host.bb);

    const result = (await host.harness.callRpc("rowSignals", { threadIds })) as {
      signals: { threadId: string }[];
    };

    // §7's B37-B40 bound: four reads per thread, never more, and a row per id
    // in the order asked for — the payload, not a cache hit, is the contract.
    expect(listCalls(host)).toBe(160);
    expect(result.signals.map((signal) => signal.threadId)).toEqual(threadIds);
  });

  it("returns an all-null row for a thread with no events rather than omitting it", async () => {
    const host = hostWith({});
    await plugin(host.bb);

    const result = (await host.harness.callRpc("rowSignals", {
      threadIds: ["t1"],
    })) as { signals: unknown[] };

    expect(result.signals).toEqual([
      {
        threadId: "t1",
        contextPressure: null,
        modelFallback: null,
        isRateLimitPaused: false,
        goal: null,
      },
    ]);
  });

  it("reads every signal a thread has", async () => {
    const host = hostWith({
      events: {
        t1: [
          contextWindowUsage(50_000, 200_000),
          modelFallback(20),
          rateLimits("blocked"),
          goalUpdated(30),
        ],
      },
    });
    await plugin(host.bb);

    const result = (await host.harness.callRpc("rowSignals", {
      threadIds: ["t1"],
    })) as { signals: Record<string, unknown>[] };

    expect(result.signals[0]).toEqual({
      threadId: "t1",
      contextPressure: 0.25,
      modelFallback: {
        originalModel: "opus",
        fallbackModel: "sonnet",
        reason: "provider",
        message: "capacity",
      },
      isRateLimitPaused: true,
      goal: { status: "active", tokensUsed: 1_000, tokenBudget: 50_000 },
    });
  });

  it("leaves contextPressure null when the model context window is unknown", async () => {
    const host = hostWith({ events: { t1: [contextWindowUsage(50_000, null)] } });
    await plugin(host.bb);

    const result = (await host.harness.callRpc("rowSignals", {
      threadIds: ["t1"],
    })) as { signals: Record<string, unknown>[] };

    expect(result.signals[0]?.contextPressure).toBeNull();
  });

  it("clears the goal when the newest of the two goal events is a clear", async () => {
    const host = hostWith({ events: { t1: [goalUpdated(30), goalCleared(31)] } });
    await plugin(host.bb);

    const result = (await host.harness.callRpc("rowSignals", {
      threadIds: ["t1"],
    })) as { signals: Record<string, unknown>[] };

    expect(result.signals[0]?.goal).toBeNull();
  });

  it("still returns an older modelFallback behind 30 newer goal rows", async () => {
    // The regression guard for the per-type limit. A single combined read with
    // limit:"25" would return 25 goal rows and drop this fallback entirely.
    const host = hostWith({
      events: {
        t1: [
          modelFallback(1),
          ...Array.from({ length: 30 }, (_, index) => goalUpdated(100 + index)),
        ],
      },
    });
    await plugin(host.bb);

    const result = (await host.harness.callRpc("rowSignals", {
      threadIds: ["t1"],
    })) as { signals: Record<string, unknown>[] };

    expect(result.signals[0]?.modelFallback).toEqual({
      originalModel: "opus",
      fallbackModel: "sonnet",
      reason: "provider",
      message: "capacity",
    });
  });
});

describe("lastActivity (B82)", () => {
  it("returns the newest event's createdAt whatever its type", async () => {
    const host = hostWith({
      events: { t1: [tokenUsage(1_000), goalUpdated(30), modelFallback(20)] },
    });
    await plugin(host.bb);

    const result = (await host.harness.callRpc("lastActivity", {
      threadIds: ["t1"],
    })) as { activity: unknown[] };

    // The fake stamps `createdAt` from `seq`, so 30 is the goal event — newer
    // than the token usage the dossier reads and than the fallback.
    expect(result.activity).toEqual([{ threadId: "t1", at: 30 }]);
  });

  it("returns null for a thread with no events rather than omitting it", async () => {
    const host = hostWith({});
    await plugin(host.bb);

    const result = (await host.harness.callRpc("lastActivity", {
      threadIds: ["t1"],
    })) as { activity: unknown[] };

    expect(result.activity).toEqual([{ threadId: "t1", at: null }]);
  });

  it("reads once per thread, in the order asked for", async () => {
    const threadIds = Array.from({ length: 40 }, (_, index) => `t${index}`);
    const host = hostWith({});
    await plugin(host.bb);

    const result = (await host.harness.callRpc("lastActivity", { threadIds })) as {
      activity: { threadId: string }[];
    };

    expect(listCalls(host)).toBe(40);
    expect(result.activity.map((row) => row.threadId)).toEqual(threadIds);
  });
});

describe("contract input validation", () => {
  it("rejects more than 60 thread ids at the contract, before any handler runs", async () => {
    const host = hostWith({});
    await plugin(host.bb);

    const threadIds = Array.from({ length: 61 }, (_, index) => `t${index}`);
    await expect(host.harness.callRpc("rowSignals", { threadIds })).rejects.toThrow();
    expect(listCalls(host)).toBe(0);
  });

  it("lets exactly 60 thread ids through to the handler", async () => {
    const host = hostWith({});
    await plugin(host.bb);

    const threadIds = Array.from({ length: 60 }, (_, index) => `t${index}`);
    const result = (await host.harness.callRpc("rowSignals", { threadIds })) as {
      signals: unknown[];
    };

    expect(result.signals).toHaveLength(60);
    expect(listCalls(host)).toBe(240);
  });

  it("rejects a blank thread id", async () => {
    const host = hostWith({});
    await plugin(host.bb);

    await expect(
      host.harness.callRpc("threadDossier", { threadId: "   " }),
    ).rejects.toThrow();
  });
});

describe("handler failure (ruling 10)", () => {
  it("rejects the call rather than resolving with null fields when the SDK fails", async () => {
    const host = hostWith({});
    host.harness.inspection.sdk.stub("threads.events.list", () => {
      throw new Error("server gone");
    });
    await plugin(host.bb);

    await expect(
      host.harness.callRpc("threadDossier", { threadId: "t1" }),
    ).rejects.toThrow();

    // The failure is not cached: the next call retries.
    const before = listCalls(host);
    await expect(
      host.harness.callRpc("threadDossier", { threadId: "t1" }),
    ).rejects.toThrow();
    expect(listCalls(host)).toBeGreaterThan(before);
  });
});

describe("registration", () => {
  it("registers all five contract methods and the fourteen settings descriptors (B59, B85)", async () => {
    const host = hostWith({});
    await plugin(host.bb);

    expect(Object.keys(betterSidebarRpcContract)).toEqual([
      "threadDossier",
      "rowSignals",
      "threadExecutions",
      "lastActivity",
      "localHost",
    ]);

    const descriptors = host.harness.inspection.registrations.settingsDescriptors;
    expect(Object.keys(descriptors)).toEqual([
      "groupBy",
      "density",
      "showPrChip",
        "showRelativeTime",
      "showArchivedChildren",
      "showHeaderChip",
      "showSecondRow",
      "showProjectName",
      "showBranch",
      "showModel",
      "showEffort",
      "showQuickPin",
      "showQuickMarkRead",
      "showQuickArchive",
    ]);
    expect(descriptors.groupBy?.default).toBe("date");
    expect(descriptors.density?.default).toBe("default");
    for (const key of [
      "showPrChip",
        "showRelativeTime",
      "showArchivedChildren",
      "showHeaderChip",
      "showSecondRow",
      "showProjectName",
      "showBranch",
      "showModel",
    ] as const) {
      expect(descriptors[key]?.type).toBe("boolean");
      expect(descriptors[key]?.default).toBe(true);
    }
    // B84: effort ships off.
    expect(descriptors.showEffort?.type).toBe("boolean");
    expect(descriptors.showEffort?.default).toBe(false);
    // B85: pin replaces mark-read as the first quick action.
    for (const key of ["showQuickPin", "showQuickArchive"] as const) {
      expect(descriptors[key]?.type).toBe("boolean");
      expect(descriptors[key]?.default).toBe(true);
    }
    expect(descriptors.showQuickMarkRead?.type).toBe("boolean");
    expect(descriptors.showQuickMarkRead?.default).toBe(false);
  });

  it("offers every B65 group mode as a select option", async () => {
    const host = hostWith({});
    await plugin(host.bb);

    const groupBy = host.harness.inspection.registrations.settingsDescriptors.groupBy;
    expect(groupBy?.type === "select" ? groupBy.options : []).toEqual([
      "date",
      "project",
      "host",
      "status",
      "none",
    ]);
  });
});
