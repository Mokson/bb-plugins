// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginSidebarProject,
  PluginSidebarThread,
  PluginSidebarThreadIndicator,
  PluginSidebarThreadsState,
  PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import "./test-setup";

/**
 * The harness fixes `sidebarThreads` at render time, and B6 is only observable
 * when the thread set changes *underneath* a mounted list. Replacing this one
 * hook with a module-level variable is what makes "a thread arrived while the
 * pointer was over the list" a thing a test can stage.
 */
let threadsState: PluginSidebarThreadsState = { status: "ready", threads: [], projects: [] };

/**
 * `CompactViewportProvider` is replaced by a marker so the assertion is about
 * the list mounting it with the host's prop, not about the dossier's internals.
 */
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  experimental_useSidebarThreads: () => threadsState,
}));
vi.mock("./dossier/RowHover", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CompactViewportProvider: ({
    isCompactViewport,
    children,
  }: {
    isCompactViewport: boolean;
    children: ReactNode;
  }) => <div data-compact-provider={String(isCompactViewport)}>{children}</div>,
}));

installTestPluginRuntime();

const { ThreadList } = await import("./ThreadList");

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** 23:59 local, so one two-minute tick crosses local midnight (B3). */
const BEFORE_MIDNIGHT = new Date(2024, 4, 15, 23, 59, 0).getTime();

function thread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  const now = Date.now();
  return {
    id: "t1",
    projectId: "p1",
    title: "Ship the sidebar",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "acp-claude-code",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none" as PluginSidebarThreadIndicator,
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: now,
    updatedAt: now,
    lastReadAt: null,
    latestAttentionAt: now,
    ...overrides,
  };
}

const PROJECTS: PluginSidebarProject[] = [{ id: "p1", name: "bb-plugins", isPersonal: false }];

function ready(threads: PluginSidebarThread[]): PluginSidebarThreadsState {
  return { status: "ready", threads, projects: PROJECTS };
}

const onNavigate = vi.fn();

function props(overrides: Partial<PluginThreadListProps> = {}): PluginThreadListProps {
  return {
    activeThreadId: null,
    activeProjectId: null,
    isCompactViewport: false,
    onNavigate,
    searchQuery: "",
    Original: () => null,
    ...overrides,
  };
}

function renderList(
  overrides: Partial<PluginThreadListProps> = {},
  settings?: Record<string, string>,
) {
  return renderSlot({ component: ThreadList }, props(overrides), { settings });
}

/** The rendered order, which is the only thing B6 is actually about. */
function renderedIds(): string[] {
  return Array.from(document.querySelectorAll("[data-sidebar-thread-id]")).map(
    (node) => node.getAttribute("data-sidebar-thread-id") ?? "",
  );
}

function sectionLabels(): string[] {
  return Array.from(document.querySelectorAll("[data-sidebar-section]")).map(
    (node) => node.querySelector("h2")?.textContent ?? node.textContent ?? "",
  );
}

beforeEach(() => {
  window.localStorage.clear();
  onNavigate.mockClear();
  threadsState = ready([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ThreadList — the four list states", () => {
  it("renders skeletons while loading", () => {
    threadsState = { status: "loading", threads: [], projects: [] };
    renderList();
    expect(screen.getAllByTestId("thread-skeleton").length).toBeGreaterThan(0);
  });

  it("renders the error state, and retry re-runs the subscription", () => {
    threadsState = { status: "error", threads: [], projects: [] };
    renderList();
    expect(screen.getByText(/threads could not be loaded/i)).toBeTruthy();

    threadsState = ready([thread()]);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(renderedIds()).toEqual(["t1"]);
  });

  it("renders the empty hint when there is nothing at all", () => {
    renderList();
    expect(screen.getByText(/no threads yet/i)).toBeTruthy();
    expect(screen.queryByText(/no threads match/i)).toBeNull();
  });

  it("renders distinct copy naming the query when a search matches nothing", () => {
    threadsState = ready([thread({ title: "Ship the sidebar" })]);
    renderList({ searchQuery: "zzzz-no-such-thread" });
    expect(screen.getByText(/no threads match/i).textContent).toContain("zzzz-no-such-thread");
    expect(screen.queryByText(/no threads yet/i)).toBeNull();
  });
});

describe("ThreadList — sections and collapse (B7, B10)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BEFORE_MIDNIGHT);
  });

  it("collapses LAST 7 DAYS, keeps its count, and survives a remount", () => {
    threadsState = ready([
      thread({ id: "old", latestAttentionAt: BEFORE_MIDNIGHT - 3 * DAY }),
      thread({ id: "new", latestAttentionAt: BEFORE_MIDNIGHT }),
    ]);
    renderList();
    expect(renderedIds()).toEqual(["new", "old"]);

    const header = screen.getByRole("button", { name: /last 7 days/i });
    expect(header.textContent).toContain("1");
    fireEvent.click(header);
    expect(renderedIds()).toEqual(["new"]);
    // The count survives the collapse, or the header stops saying what it hides.
    expect(screen.getByRole("button", { name: /last 7 days/i }).textContent).toContain("1");

    cleanup();
    renderList();
    expect(renderedIds()).toEqual(["new"]);
  });

  it("renders no collapse control for NEEDS YOU or PINNED", () => {
    threadsState = ready([
      thread({ id: "needs", hasPendingInteraction: true }),
      thread({ id: "pin", isPinned: true }),
      thread({ id: "plain" }),
    ]);
    renderList();

    expect(screen.queryByRole("button", { name: /needs you/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /pinned/i })).toBeNull();
    expect(screen.getByRole("button", { name: /today/i })).toBeTruthy();
  });

  it("collapses a subtree from its parent chevron (B10)", () => {
    threadsState = ready([
      thread({ id: "parent" }),
      thread({ id: "child", parentThreadId: "parent" }),
    ]);
    renderList();
    expect(renderedIds()).toEqual(["parent", "child"]);

    fireEvent.click(screen.getByRole("button", { name: /collapse|expand/i }));
    expect(renderedIds()).toEqual(["parent"]);
  });
});

describe("ThreadList — the clock (B3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BEFORE_MIDNIGHT);
  });

  it("re-partitions across local midnight with no data change", () => {
    const threads = [thread({ id: "t1", latestAttentionAt: BEFORE_MIDNIGHT })];
    threadsState = ready(threads);
    renderList();
    expect(sectionLabels()[0]).toContain("TODAY");

    // Same array identity, same timestamps — only the clock moved. A timer
    // scheduled inside an advance window does not fire in that same call, so
    // the two minutes are advanced one at a time.
    act(() => void vi.advanceTimersByTime(MINUTE));
    act(() => void vi.advanceTimersByTime(MINUTE));
    expect(threadsState.threads).toBe(threads);
    expect(sectionLabels()[0]).toContain("YESTERDAY");
  });
});

describe("ThreadList — freeze (B6)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BEFORE_MIDNIGHT);
  });

  it("a NEEDS YOU thread arriving while frozen changes no existing row's index", () => {
    threadsState = ready([
      thread({ id: "a", latestAttentionAt: BEFORE_MIDNIGHT }),
      thread({ id: "b", latestAttentionAt: BEFORE_MIDNIGHT - MINUTE }),
    ]);
    const slot = renderList();
    const before = renderedIds();
    expect(before).toEqual(["a", "b"]);

    fireEvent.pointerOver(document.querySelector("[data-better-sidebar-list]")!);

    // A pending-interaction thread would normally hoist itself to the top of
    // the list, above both frozen rows, under the user's pointer.
    threadsState = ready([
      ...threadsState.threads,
      thread({ id: "urgent", hasPendingInteraction: true, latestAttentionAt: BEFORE_MIDNIGHT }),
    ]);
    slot.lifecycle.rerender(<ThreadList {...props()} />);

    const during = renderedIds();
    expect(during.slice(0, before.length)).toEqual(before);
    expect(during[before.length]).toBe("urgent");

    // On release it takes its sorted position at the head of the list.
    fireEvent.pointerOut(document.querySelector("[data-better-sidebar-list]")!);
    act(() => void vi.advanceTimersByTime(1000));
    act(() => void vi.advanceTimersByTime(1500));
    expect(renderedIds()[0]).toBe("urgent");
  });

  it("a search-query change releases the freeze immediately", () => {
    threadsState = ready([
      thread({ id: "a", title: "alpha" }),
      thread({ id: "b", title: "beta" }),
    ]);
    const slot = renderList();
    fireEvent.pointerOver(document.querySelector("[data-better-sidebar-list]")!);
    expect(renderedIds()).toEqual(["a", "b"]);

    slot.lifecycle.rerender(<ThreadList {...props({ searchQuery: "beta" })} />);
    expect(renderedIds()).toEqual(["b"]);
  });
});

describe("ThreadList — host contract", () => {
  it("calls onNavigate and opens the thread when a row is clicked (B47)", () => {
    threadsState = ready([thread()]);
    const slot = renderList();

    fireEvent.click(screen.getByText("Ship the sidebar"));

    expect(slot.inspection.sidebarActionCalls).toContainEqual(
      expect.objectContaining({ method: "open", threadId: "t1" }),
    );
    expect(onNavigate).toHaveBeenCalled();
  });

  it("mounts CompactViewportProvider with the host's prop", () => {
    threadsState = ready([thread()]);
    renderList({ isCompactViewport: true });
    expect(document.querySelector('[data-compact-provider="true"]')).not.toBeNull();
  });
});

describe("ThreadList — second row (B18, B19)", () => {
  function hasSecondRow(): boolean {
    return screen.queryAllByText("bb-plugins").length > 0;
  }

  it.each([
    ["date", true],
    ["none", true],
    ["project", false],
  ] as const)("auto shows row 2 under groupBy %s: %s", (groupBy, expected) => {
    threadsState = ready([thread()]);
    renderList({}, { groupBy, secondRow: "auto" });
    expect(hasSecondRow()).toBe(expected);
  });

  it.each(["date", "none", "project"] as const)("always overrides under groupBy %s", (groupBy) => {
    threadsState = ready([thread()]);
    renderList({}, { groupBy, secondRow: "always" });
    expect(hasSecondRow()).toBe(true);
  });

  it.each(["date", "none", "project"] as const)("never overrides under groupBy %s", (groupBy) => {
    threadsState = ready([thread()]);
    renderList({}, { groupBy, secondRow: "never" });
    expect(hasSecondRow()).toBe(false);
  });

  it("still renders row 2 on a compact viewport (B19)", () => {
    threadsState = ready([thread()]);
    renderList({ isCompactViewport: true });
    expect(hasSecondRow()).toBe(true);
  });
});
