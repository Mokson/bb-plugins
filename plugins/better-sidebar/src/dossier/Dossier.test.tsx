// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import {
  installTestPluginRuntime,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { RenderRow } from "../model/types";

installTestPluginRuntime();

const { Dossier } = await import("./Dossier");
const { useDossier, resetDossierCache } = await import("./useDossier");
const { resetRowSignals } = await import("./useRowSignals");
const { RowSignals } = await import("./RowSignals");
const { betterSidebarRpcContract } = await import("../server-contract");

type Contract = typeof betterSidebarRpcContract;
type DossierPayload = Awaited<
  ReturnType<PluginRpcTestHandlers<Contract>["threadDossier"]>
>;

const THREAD_ID = "t1";

/** B30's tripwire: any figure that reads as money, in any of bb's currencies. */
const CURRENCY = /(?:[$€£¥]\s?\d)|(?:\d\s?(?:USD|EUR|GBP|cents?|dollars?))/i;

function full(): DossierPayload {
  return {
    threadId: THREAD_ID,
    execution: { model: "claude-opus-5", reasoningLevel: "high" },
    economics: {
      total: {
        totalTokens: 1234,
        inputTokens: 1000,
        cachedInputTokens: 900,
        outputTokens: 200,
        reasoningOutputTokens: 34,
      },
      modelContextWindow: 200_000,
    },
    contextWindow: {
      usedTokens: 50_000,
      modelContextWindow: 200_000,
      estimated: false,
    },
    fetchedAt: 0,
  };
}

function thread(): PluginSidebarThread {
  return {
    id: THREAD_ID,
    projectId: "proj_1",
    title: "Rework the sidebar",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 2,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 1,
    },
    indicator: "waiting-for-input",
    indicatorLabel: "Thread is working",
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: Date.UTC(2026, 0, 1, 9, 30, 0),
    updatedAt: Date.UTC(2026, 0, 1, 10, 15, 0),
    lastReadAt: null,
    latestAttentionAt: 0,
  };
}

/** The row the list already built; the dossier reads its identity from here. */
function row(overrides: Partial<RenderRow> = {}): RenderRow {
  return {
    thread: thread(),
    title: "Rework the sidebar",
    workspaceLabel: "feat/a-very-long-branch-name-row-two-truncates",
    depth: 0,
    childCount: 0,
    projectName: "bb",
    dimLevel: 0,
    sectionKey: "today",
    ...overrides,
  };
}

function Harness({ variant }: { variant?: "rich" | "minimal" }) {
  const state = useDossier(THREAD_ID, variant !== "minimal");
  return <Dossier row={row()} state={state} variant={variant} />;
}

function render(rpc: Partial<PluginRpcTestHandlers<Contract>> = {}) {
  return renderSlot<{ variant?: "rich" | "minimal" }, Contract>({ component: Harness }, {}, {
    rpc: {
      threadDossier: () => full(),
      rowSignals: () => ({ signals: [] }),
      threadExecutions: () => ({ executions: [] }),
      ...rpc,
    },
    sidebarThreads: {
      status: "ready",
      threads: [thread()],
      projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
    },
  });
}

/** B38's dossier section reads the same signal cache the row cluster fills. */
function SignalsHarness() {
  const state = useDossier(THREAD_ID, true);
  return (
    <>
      <RowSignals threadId={THREAD_ID} />
      <Dossier row={row()} state={state} />
    </>
  );
}

function renderWithSignals(rpc: Partial<PluginRpcTestHandlers<Contract>> = {}) {
  installIntersectingObserver();
  return renderSlot<Record<string, never>, Contract>(
    { component: SignalsHarness },
    {},
    {
      rpc: {
        threadDossier: () => full(),
        rowSignals: () => ({ signals: [] }),
      threadExecutions: () => ({ executions: [] }),
        ...rpc,
      },
      sidebarThreads: {
        status: "ready",
        threads: [thread()],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
    },
  );
}

/** jsdom ships no IntersectionObserver; this one reports everything visible. */
function installIntersectingObserver() {
  class Stub implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds: readonly number[] = [];
    readonly scrollMargin = "";
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ target, isIntersecting: true } as IntersectionObserverEntry],
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

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  resetDossierCache();
  resetRowSignals();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Dossier contents (B29)", () => {
  it("renders every field that is present", async () => {
    render();
    await settle();

    expect(screen.getByText("Rework the sidebar")).not.toBeNull();
    expect(screen.getByText("Thread is working")).not.toBeNull();
    // Only non-zero activity counts.
    expect(document.querySelector('[data-dossier-activity="workflows"]')).not.toBeNull();
    expect(document.querySelector('[data-dossier-activity="goals"]')).not.toBeNull();
    expect(
      document.querySelector('[data-dossier-activity="backgroundAgents"]'),
    ).toBeNull();

    expect(screen.getByText("claude-opus-5 · high")).not.toBeNull();
    expect(screen.getByText("2026-01-01 09:30:00 UTC")).not.toBeNull();
    expect(screen.getByText("2026-01-01 10:15:00 UTC")).not.toBeNull();
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("25");
    expect(screen.getByText("1,234")).not.toBeNull();
    expect(screen.getByText("900")).not.toBeNull();
  });

  it("omits model and effort together when execution options never resolved (§7 B29)", async () => {
    render({ threadDossier: () => ({ ...full(), execution: null }) });
    await settle();

    expect(screen.queryByText(/claude-opus-5/)).toBeNull();
    expect(screen.queryByText("Model")).toBeNull();
    // The rest of the dossier still renders.
    expect(screen.getByText("Rework the sidebar")).not.toBeNull();
    expect(screen.getByText("1,234")).not.toBeNull();
  });
});

describe("Dossier economics (B30, B31)", () => {
  it("omits the economics section entirely for a null payload, with no zeros or dashes", async () => {
    const slot = render({
      threadDossier: () => ({ ...full(), economics: null, contextWindow: null }),
    });
    await settle();

    const text = slot.container.textContent ?? "";
    expect(screen.queryByText("Tokens")).toBeNull();
    expect(screen.queryByText("Total")).toBeNull();
    expect(text).not.toMatch(/\b0\b/);
    expect(text).not.toContain("—");
    expect(screen.queryByRole("meter")).toBeNull();

    // …and the rest of the dossier still renders. This is `status: "ready"`,
    // not the error branch — the two can never be conflated.
    expect(screen.getByText("Rework the sidebar")).not.toBeNull();
    expect(screen.getByText("claude-opus-5 · high")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders no monetary figure anywhere, in either payload shape", async () => {
    const slot = render();
    await settle();
    expect(slot.container.textContent ?? "").not.toMatch(CURRENCY);

    cleanup();
    resetDossierCache();
    const nulled = render({
      threadDossier: () => ({ ...full(), economics: null }),
    });
    await settle();
    expect(nulled.container.textContent ?? "").not.toMatch(CURRENCY);
  });
});

describe("Dossier error branch (ruling 10)", () => {
  it("renders one inline error line and a retry, and no spinner", async () => {
    render({
      threadDossier: () => {
        throw new Error("backend unavailable");
      },
    });
    await settle();

    expect(screen.getByRole("alert").textContent).toBe("backend unavailable");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Retry")).not.toBeNull();
    expect(screen.queryByTestId("dossier-skeleton")).toBeNull();
  });
});

describe("Row signals refresh (B37-B40)", () => {
  /**
   * `runBatch` was reachable only from an IntersectionObserver callback or the
   * invalidation channel, so a viewport nobody scrolled and a thread nobody
   * touched had no path back to it at all: every glyph aged past the 30s TTL
   * and never returned.
   */
  it("refreshes a stationary viewport's signals once the TTL lapses", async () => {
    const slot = renderWithSignals();
    await settle();
    const calls = () =>
      slot.inspection.rpcCalls.filter((c) => c.method === "rowSignals").length;
    expect(calls()).toBe(1);

    // Nothing scrolls, nothing publishes. Only the clock moves.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(46_000);
    });
    await settle();
    expect(calls()).toBe(2);
  });
});

describe("Dossier model fallback (B38)", () => {
  it("names originalModel, fallbackModel and the reason", async () => {
    renderWithSignals({
      rowSignals: ({ threadIds }) => ({
        signals: threadIds.map((threadId) => ({
          threadId,
          contextPressure: null,
          modelFallback: {
            originalModel: "claude-opus-5",
            fallbackModel: "claude-sonnet-5",
            reason: "capacity",
            message: "Falling back",
          },
          isRateLimitPaused: false,
          goal: null,
        })),
      }),
    });
    await settle();

    expect(screen.getByText("Model fallback")).not.toBeNull();
    expect(screen.getByText("claude-sonnet-5")).not.toBeNull();
    expect(screen.getByText("capacity")).not.toBeNull();
    // `originalModel` is also the execution model here, so pin both cells.
    expect(document.body.textContent).toContain("claude-opus-5");
  });
});
