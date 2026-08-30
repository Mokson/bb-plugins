// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import {
  installTestPluginRuntime,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";

installTestPluginRuntime();

const { RowHover, CompactViewportProvider, resetHoverSuppression } = await import(
  "./RowHover"
);
const { resetDossierCache } = await import("./useDossier");
const { resetRowSignals } = await import("./useRowSignals");
const { betterSidebarRpcContract } = await import("../server-contract");

type Contract = typeof betterSidebarRpcContract;

function dossier(threadId: string) {
  return {
    threadId,
    execution: { model: "claude-opus-5", reasoningLevel: "high" },
    economics: {
      total: {
        totalTokens: 1234,
        inputTokens: 1000,
        cachedInputTokens: 900,
        outputTokens: 200,
        reasoningOutputTokens: 34,
      },
      modelContextWindow: 200000,
    },
    contextWindow: {
      usedTokens: 50000,
      modelContextWindow: 200000,
      estimated: false,
    },
    fetchedAt: 0,
  };
}

function thread(id: string): PluginSidebarThread {
  return {
    id,
    projectId: "proj_1",
    title: `Thread ${id}`,
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    lastReadAt: null,
    latestAttentionAt: 2_000,
  };
}

function handlers(
  overrides: Partial<PluginRpcTestHandlers<Contract>> = {},
): PluginRpcTestHandlers<Contract> {
  return {
    threadDossier: ({ threadId }) => dossier(threadId),
    rowSignals: () => ({ signals: [] }),
    ...overrides,
  };
}

function Harness({
  threadIds,
  isCompactViewport,
}: {
  threadIds: string[];
  isCompactViewport?: boolean;
}) {
  const rows = (
    <div>
      {threadIds.map((id) => (
        <RowHover key={id} threadId={id}>
          <span>row {id}</span>
        </RowHover>
      ))}
    </div>
  );
  return isCompactViewport === undefined ? (
    rows
  ) : (
    <CompactViewportProvider isCompactViewport={isCompactViewport}>
      {rows}
    </CompactViewportProvider>
  );
}

function render(
  threadIds: string[],
  options: {
    isCompactViewport?: boolean;
    rpc?: Partial<PluginRpcTestHandlers<Contract>>;
    settings?: Record<string, string | boolean>;
  } = {},
) {
  return renderSlot<
    { threadIds: string[]; isCompactViewport?: boolean },
    Contract
  >(
    { component: Harness },
    { threadIds, isCompactViewport: options.isCompactViewport },
    {
      rpc: handlers(options.rpc),
      settings: options.settings,
      sidebarThreads: {
        status: "ready",
        threads: threadIds.map(thread),
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
    },
  );
}

function hover(threadId: string) {
  const trigger = document.querySelector(
    `[data-better-sidebar-hover-trigger="${threadId}"]`,
  );
  if (trigger === null) throw new Error(`no hover trigger for ${threadId}`);
  fireEvent.pointerOver(trigger);
  return trigger;
}

function unhover(trigger: Element) {
  fireEvent.pointerOut(trigger);
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  resetDossierCache();
  resetRowSignals();
  resetHoverSuppression();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("RowHover hover intent (B26)", () => {
  it("opens after ~250ms and not before", async () => {
    render(["t1"]);
    hover("t1");

    await advance(249);
    expect(screen.queryByText("Thread t1")).toBeNull();

    await advance(1);
    expect(screen.getByText("Thread t1")).not.toBeNull();
  });

  it("is suppressed by a pointer-down anywhere, and for 300ms after release", async () => {
    render(["t1"]);
    hover("t1");

    // A split-drag: the button goes down somewhere else entirely.
    await act(async () => {
      fireEvent.pointerDown(document.body);
    });
    await advance(1000);
    expect(screen.queryByText("Thread t1")).toBeNull();

    await act(async () => {
      fireEvent.pointerUp(document.body);
    });
    // Still suppressed through the 300ms release window, so the hover-intent
    // timer cannot even start.
    await advance(299);
    expect(screen.queryByText("Thread t1")).toBeNull();

    // The release lands here; hover intent re-arms and needs its own 250ms.
    await advance(1);
    expect(screen.queryByText("Thread t1")).toBeNull();
    await advance(250);
    expect(screen.getByText("Thread t1")).not.toBeNull();
  });
});

describe("RowHover request accounting (B27, B28)", () => {
  it("mounting 50 threads issues zero dossier calls", async () => {
    const slot = render(Array.from({ length: 50 }, (_, i) => `t${i}`));
    await advance(5_000);
    expect(
      slot.inspection.rpcCalls.filter((c) => c.method === "threadDossier"),
    ).toHaveLength(0);
  });

  it("hovering three rows issues exactly three dossier calls", async () => {
    const slot = render(["t1", "t2", "t3"]);
    for (const id of ["t1", "t2", "t3"]) {
      const trigger = hover(id);
      await advance(300);
      unhover(trigger);
      await advance(10);
    }
    expect(
      slot.inspection.rpcCalls.filter((c) => c.method === "threadDossier"),
    ).toHaveLength(3);
  });

  it("a second hover inside the TTL renders on the first paint with no new call", async () => {
    const slot = render(["t1"]);
    const trigger = hover("t1");
    await advance(300);
    expect(screen.getByText("claude-opus-5 · high")).not.toBeNull();
    const afterFirst = slot.inspection.rpcCalls.length;

    unhover(trigger);
    await advance(1_000);
    hover("t1");
    await advance(250);

    // Populated content, and not one further request.
    expect(screen.getByText("claude-opus-5 · high")).not.toBeNull();
    expect(screen.queryByTestId("dossier-skeleton")).toBeNull();
    expect(slot.inspection.rpcCalls).toHaveLength(afterFirst);
  });
});

describe("RowHover on a compact viewport (B32)", () => {
  it("renders no dossier at any hover duration and attaches no pointer handler", async () => {
    const slot = render(["t1"], { isCompactViewport: true });
    expect(
      document.querySelector('[data-better-sidebar-hover-trigger="t1"]'),
    ).toBeNull();
    expect(screen.getByText("row t1")).not.toBeNull();

    await advance(10_000);
    expect(screen.queryByText("Thread t1")).toBeNull();
    expect(slot.inspection.rpcCalls).toHaveLength(0);
  });

  it("renders no dossier when the tooltip setting is off", async () => {
    render(["t1"], { settings: { tooltip: "off" } });
    expect(
      document.querySelector('[data-better-sidebar-hover-trigger="t1"]'),
    ).toBeNull();
  });
});
