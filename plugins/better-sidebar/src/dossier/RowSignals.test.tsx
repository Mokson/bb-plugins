// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import {
  installTestPluginRuntime,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import type { RowSignal } from "../server-contract";

installTestPluginRuntime();

const { RowSignals } = await import("./RowSignals");
const { resetRowSignals } = await import("./useRowSignals");
const { betterSidebarRpcContract, DOSSIER_CHANNEL } = await import(
  "../server-contract"
);

type Contract = typeof betterSidebarRpcContract;

function signal(threadId: string, overrides: Partial<RowSignal> = {}): RowSignal {
  return {
    threadId,
    contextPressure: null,
    modelFallback: null,
    isRateLimitPaused: false,
    goal: null,
    ...overrides,
  };
}

/**
 * jsdom ships no IntersectionObserver (§11). The mock reports intersection
 * only for the ids in `visibleIds`, so a row that never scrolls into view
 * contributes nothing to the batch — the property §7's ruling turns on.
 */
let visibleIds = new Set<string>();
const observedTargets: Element[] = [];
let notifyIntersection:
  | ((entries: IntersectionObserverEntry[]) => void)
  | null = null;

function installObserver() {
  class Stub implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds: readonly number[] = [];
    readonly scrollMargin = "";
    constructor(private readonly callback: IntersectionObserverCallback) {
      notifyIntersection = (entries) => callback(entries, this);
    }
    observe(target: Element) {
      observedTargets.push(target);
      const id = target.getAttribute("data-better-sidebar-signals") ?? "";
      this.callback(
        [{ target, isIntersecting: visibleIds.has(id) } as IntersectionObserverEntry],
        this,
      );
    }
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", Stub);
}

function Harness({ threadIds }: { threadIds: string[] }) {
  return (
    <div>
      {threadIds.map((id) => (
        <RowSignals key={id} threadId={id} />
      ))}
    </div>
  );
}

function render(threadIds: string[], signals: RowSignal[]) {
  return renderSlot<{ threadIds: string[] }, Contract>(
    { component: Harness },
    { threadIds },
    {
      rpc: {
        threadDossier: ({ threadId }) => ({
          threadId,
          execution: null,
          economics: null,
          contextWindow: null,
          fetchedAt: 0,
        }),
        rowSignals: ({ threadIds: requested }) => ({
          signals: signals.filter((s) => requested.includes(s.threadId)),
        }),
        threadExecutions: () => ({ executions: [] }),
        lastActivity: () => ({ activity: [] }),
        threadWorkStats: () => ({ stats: [] }),
        localHost: () => ({ hostId: null }),
      },
    },
  );
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
}

const cluster = (threadId: string) =>
  document.querySelector(`[data-better-sidebar-signals="${threadId}"]`);
const glyph = (threadId: string, kind: string) =>
  cluster(threadId)?.querySelector(`[data-signal="${kind}"]`) ?? null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  resetRowSignals();
  visibleIds = new Set(["t1"]);
  observedTargets.length = 0;
  installObserver();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("RowSignals glyphs", () => {
  it("draws the context-pressure warning above 80% and nothing at or below (B37)", async () => {
    visibleIds = new Set(["hot", "warm", "unknown"]);
    render(["hot", "warm", "unknown"], [
      signal("hot", { contextPressure: 0.85 }),
      signal("warm", { contextPressure: 0.5 }),
      signal("unknown", { contextPressure: null }),
    ]);
    await settle();

    expect(glyph("hot", "context-pressure")).not.toBeNull();
    expect(glyph("warm", "context-pressure")).toBeNull();
    expect(glyph("unknown", "context-pressure")).toBeNull();
  });

  it("draws the fallback glyph (B38) and the rate-limit glyph distinctly (B39)", async () => {
    visibleIds = new Set(["fell", "paused", "idle"]);
    render(["fell", "paused", "idle"], [
      signal("fell", {
        modelFallback: {
          originalModel: "claude-opus-5",
          fallbackModel: "claude-sonnet-5",
          reason: "capacity",
          message: "Falling back",
        },
      }),
      signal("paused", { isRateLimitPaused: true }),
      signal("idle"),
    ]);
    await settle();

    expect(glyph("fell", "model-fallback")).not.toBeNull();
    expect(glyph("paused", "rate-limit-paused")).not.toBeNull();
    // Distinct from each other and from a plain idle row.
    expect(glyph("paused", "model-fallback")).toBeNull();
    expect(glyph("fell", "rate-limit-paused")).toBeNull();
    expect(cluster("idle")?.querySelector("[data-signal]")).toBeNull();
  });

  it("draws the goal ring at tokensUsed / tokenBudget, and full when budgetLimited (B40)", async () => {
    visibleIds = new Set(["half", "capped", "unbounded"]);
    render(["half", "capped", "unbounded"], [
      signal("half", {
        goal: { status: "active", tokensUsed: 500, tokenBudget: 1000 },
      }),
      signal("capped", {
        goal: { status: "budgetLimited", tokensUsed: 10, tokenBudget: 1000 },
      }),
      signal("unbounded", {
        goal: { status: "active", tokensUsed: 500, tokenBudget: null },
      }),
    ]);
    await settle();

    expect(glyph("half", "goal-ring")?.getAttribute("data-goal-progress")).toBe("0.5");
    expect(glyph("capped", "goal-ring")?.getAttribute("data-goal-progress")).toBe("1");
    expect(glyph("unbounded", "goal-ring")).toBeNull();
  });
});

describe("useRowSignals batching (§7 B37-B40 ruling)", () => {
  it("sends one request for the visible ids only", async () => {
    visibleIds = new Set(["t1", "t2"]);
    const slot = render(["t1", "t2", "offscreen"], [signal("t1"), signal("t2")]);
    await settle();

    const calls = slot.inspection.rpcCalls.filter((c) => c.method === "rowSignals");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toEqual({ threadIds: ["t1", "t2"] });
    // A row that never intersected draws nothing and costs nothing.
    expect(cluster("offscreen")?.querySelector("[data-signal]")).toBeNull();
  });

  it("re-requests when the visible set grows", async () => {
    visibleIds = new Set(["t1"]);
    const slot = render(["t1", "t2"], [signal("t1"), signal("t2")]);
    await settle();
    expect(
      slot.inspection.rpcCalls.filter((c) => c.method === "rowSignals"),
    ).toHaveLength(1);

    // The user scrolls: t2 enters the viewport.
    const target = observedTargets.find(
      (element) => element.getAttribute("data-better-sidebar-signals") === "t2",
    )!;
    visibleIds.add("t2");
    await act(async () => {
      notifyIntersection!([
        { target, isIntersecting: true } as IntersectionObserverEntry,
      ]);
    });
    await settle();

    const calls = slot.inspection.rpcCalls.filter((c) => c.method === "rowSignals");
    expect(calls).toHaveLength(2);
    expect(calls[1]!.input).toEqual({ threadIds: ["t2"] });
  });

  it("caches within the 30s TTL and drops the entry on the invalidation channel", async () => {
    visibleIds = new Set(["t1"]);
    const slot = render(["t1"], [signal("t1", { isRateLimitPaused: true })]);
    await settle();
    expect(
      slot.inspection.rpcCalls.filter((c) => c.method === "rowSignals"),
    ).toHaveLength(1);
    expect(glyph("t1", "rate-limit-paused")).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    await settle();
    expect(
      slot.inspection.rpcCalls.filter((c) => c.method === "rowSignals"),
    ).toHaveLength(1);

    await slot.behavior.emitRealtime(DOSSIER_CHANNEL, { threadId: "t1" });
    await settle();
    expect(
      slot.inspection.rpcCalls.filter((c) => c.method === "rowSignals"),
    ).toHaveLength(2);
  });

  it("renders no glyphs and does not throw when the batch rejects", async () => {
    visibleIds = new Set(["t1"]);
    const slot = renderSlot<{ threadIds: string[] }, Contract>(
      { component: Harness },
      { threadIds: ["t1"] },
      {
        rpc: {
          threadDossier: () => {
            throw new Error("unused");
          },
          rowSignals: () => {
            throw new Error("signals unavailable");
          },
          threadExecutions: () => ({ executions: [] }),
          lastActivity: () => ({ activity: [] }),
          threadWorkStats: () => ({ stats: [] }),
          localHost: () => ({ hostId: null }),
        },
      },
    );
    await settle();

    expect(cluster("t1")?.querySelector("[data-signal]")).toBeNull();
    expect(
      slot.inspection.rpcCalls.filter((c) => c.method === "rowSignals"),
    ).toHaveLength(1);
  });
});
