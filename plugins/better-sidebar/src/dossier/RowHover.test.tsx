// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import {
  installTestPluginRuntime,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { RenderRow } from "../model/types";

installTestPluginRuntime();

const { RowHover, resetHoverSuppression } = await import("./RowHover");
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
    threadExecutions: () => ({ executions: [] }),
    lastActivity: () => ({ activity: [] }),
    localHost: () => ({ hostId: null }),
    ...overrides,
  };
}

/** The list already built these; `RowHover` takes one whole, not an id. */
function row(id: string): RenderRow {
  return {
    thread: thread(id),
    title: `Thread ${id}`,
    workspaceLabel: `feat/${id}-a-branch-row-two-truncates`,
    depth: 0,
    childCount: 0,
    projectName: "bb",
    dimLevel: 0,
    sectionKey: "today",
  };
}

function Harness({
  threadIds,
  isCompactViewport = false,
}: {
  threadIds: string[];
  isCompactViewport?: boolean;
}) {
  return (
    <div>
      {threadIds.map((id) => (
        <RowHover key={id} row={row(id)} isCompactViewport={isCompactViewport}>
          <span>row {id}</span>
        </RowHover>
      ))}
    </div>
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

const CLOSE_GRACE_MS = 150;

describe("RowHover hover intent (B26)", () => {
  it("opens after ~900ms and not before", async () => {
    render(["t1"]);
    hover("t1");

    await advance(899);
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

    // The release lands here; hover intent re-arms and needs its own 900ms.
    await advance(1);
    expect(screen.queryByText("Thread t1")).toBeNull();
    await advance(900);
    expect(screen.getByText("Thread t1")).not.toBeNull();
  });
});

/**
 * `pointerleave` fires only on a boundary crossing, so it is missed whenever
 * the row leaves the pointer instead of the pointer leaving the row. Each of
 * these used to strand an open card with nothing left to close it.
 */
describe("RowHover close fallbacks", () => {
  it("closes when the pointer moves elsewhere without a pointerleave", async () => {
    render(["t1"]);
    hover("t1");
    await advance(950);
    expect(screen.getByText("Thread t1")).not.toBeNull();

    // The row moved out from under the pointer, so no pointerleave arrives.
    await act(async () => {
      fireEvent.pointerMove(document.body);
    });
    await advance(CLOSE_GRACE_MS);
    expect(screen.queryByText("Thread t1")).toBeNull();
  });

  it("keeps the grace window bounded while the pointer keeps moving outside", async () => {
    render(["t1"]);
    const trigger = hover("t1");
    await advance(950);

    unhover(trigger);
    // Continuous movement outside must not restart the pending close timer.
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        fireEvent.pointerMove(document.body);
      });
      await advance(40);
    }
    expect(screen.queryByText("Thread t1")).toBeNull();
  });

  it("still lets the pointer cross onto the card", async () => {
    render(["t1"]);
    const trigger = hover("t1");
    await advance(950);

    unhover(trigger);
    const card = document.querySelector("[data-better-sidebar-dossier]");
    if (card === null) throw new Error("no dossier");
    await act(async () => {
      fireEvent.pointerMove(card);
      fireEvent.pointerEnter(card.parentElement as Element);
    });
    await advance(2_000);
    expect(screen.getByText("Thread t1")).not.toBeNull();
  });

  it("closes on a sidebar scroll, which moves no pointer at all", async () => {
    render(["t1"]);
    hover("t1");
    await advance(950);

    await act(async () => {
      fireEvent.scroll(document.body);
    });
    expect(screen.queryByText("Thread t1")).toBeNull();
  });

  it("closes when the window loses focus", async () => {
    render(["t1"]);
    hover("t1");
    await advance(950);

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(screen.queryByText("Thread t1")).toBeNull();
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
      await advance(950);
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
    await advance(950);
    expect(screen.getByText("claude-opus-5 · high")).not.toBeNull();
    const afterFirst = slot.inspection.rpcCalls.length;

    unhover(trigger);
    await advance(1_000);
    hover("t1");
    await advance(900);

    // Populated content, and not one further request.
    expect(screen.getByText("claude-opus-5 · high")).not.toBeNull();
    expect(screen.queryByTestId("dossier-skeleton")).toBeNull();
    expect(slot.inspection.rpcCalls).toHaveLength(afterFirst);
  });
});

describe("RowHover density: compact (B60.1, B61.3)", () => {
  /**
   * The call-count assertion, not a DOM-absence one: a card that renders
   * nothing while the fetch still runs is exactly the failure B61 forbids.
   */
  it("draws no card at any hover duration and issues no backend call", async () => {
    const slot = render(["t1"], { settings: { density: "compact" } });
    // No trigger at all, so no pointer handler is attached either.
    expect(
      document.querySelector('[data-better-sidebar-hover-trigger="t1"]'),
    ).toBeNull();

    await advance(10_000);
    expect(screen.queryByText("Thread t1")).toBeNull();
    expect(screen.queryByTestId("dossier-skeleton")).toBeNull();
    expect(slot.inspection.rpcCalls).toHaveLength(0);
  });

  it("shows the rich card at density detailed", async () => {
    const slot = render(["t1"], { settings: { density: "detailed" } });
    hover("t1");
    await advance(950);
    expect(screen.getByText("claude-opus-5 · high")).not.toBeNull();
    expect(
      slot.inspection.rpcCalls.filter((c) => c.method === "threadDossier").length,
    ).toBe(1);
  });

  it("carries the full branch in the rich variant too", async () => {
    render(["t1"]);
    hover("t1");
    await advance(950);
    expect(
      screen.getByText("feat/t1-a-branch-row-two-truncates"),
    ).not.toBeNull();
  });
});

describe("RowHover error branch reachability (ruling 10)", () => {
  /**
   * Leaving the row used to clear hover state immediately, so Radix unmounted
   * the card before the pointer could cross onto it. An error state whose
   * Retry cannot be clicked is not an error state.
   */
  it("survives the pointer crossing from the row onto the card, so Retry works", async () => {
    let failing = true;
    const slot = render(["t1"], {
      rpc: {
        threadDossier: ({ threadId }) => {
          if (failing) throw new Error("backend unavailable");
          return dossier(threadId);
        },
      },
    });

    const trigger = hover("t1");
    await advance(950);
    expect(screen.getByRole("alert").textContent).toBe("backend unavailable");

    // The pointer leaves the row on its way to the button.
    unhover(trigger);
    await advance(50);
    const retry = screen.getByText("Retry");
    fireEvent.pointerOver(retry);
    await advance(1_000);

    // Still mounted well past the grace window, because the pointer is on it.
    expect(screen.getByText("Retry")).not.toBeNull();

    failing = false;
    await act(async () => {
      fireEvent.click(retry);
    });
    await advance(10);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("claude-opus-5 · high")).not.toBeNull();
    expect(
      slot.inspection.rpcCalls.filter((c) => c.method === "threadDossier").length,
    ).toBeGreaterThan(1);
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

  it("renders no dossier at density compact either (B60)", async () => {
    render(["t1"], { settings: { density: "compact" } });
    expect(
      document.querySelector('[data-better-sidebar-hover-trigger="t1"]'),
    ).toBeNull();
  });
});
