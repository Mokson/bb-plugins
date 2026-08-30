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
import "./test-setup";

/**
 * The harness fixes `sidebarThreads` at render time, and B6 is only observable
 * when the thread set changes *underneath* a mounted list. Replacing this one
 * hook with a module-level variable is what makes "a thread arrived while the
 * pointer was over the list" a thing a test can stage.
 */
let threadsState: PluginSidebarThreadsState = { status: "ready", threads: [], projects: [] };

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  experimental_useSidebarThreads: () => threadsState,
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

const PROJECTS: PluginSidebarProject[] = [
  { id: "p1", name: "bb-plugins", isPersonal: false },
  // A second project, so B64's scope has something to scope to.
  { id: "p2", name: "Beta", isPersonal: false },
];

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

/** Radix opens the display menu from the keyboard with no pointer shims. */
function openDisplayMenu() {
  fireEvent.keyDown(screen.getByLabelText("Display options"), { key: "Enter" });
}

/** Opens the menu, walks into one submenu, and picks one radio item. */
function choose(submenu: string, item: string) {
  openDisplayMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: submenu }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: item }));
}

function checkedItem(submenu: string): string {
  openDisplayMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: submenu }));
  const menu = screen.getByRole("menu", { name: submenu });
  const checked = menu.querySelector('[aria-checked="true"]')?.textContent?.trim() ?? "";
  fireEvent.keyDown(menu, { key: "Escape" });
  return checked;
}

function submenuItems(submenu: string): string[] {
  openDisplayMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: submenu }));
  const menu = screen.getByRole("menu", { name: submenu });
  const items = Array.from(menu.querySelectorAll('[role="menuitemradio"]')).map(
    (node) => node.textContent?.trim() ?? "",
  );
  fireEvent.keyDown(menu, { key: "Escape" });
  return items;
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

  /**
   * B41 (§7): the stale gradient reaches section headers. It was derived from
   * `rows[0]`, which a collapsed section does not have — so collapsing a
   * dimmed section snapped its header back to full opacity, and the gradient
   * broke exactly where the user was looking.
   */
  it("keeps a collapsed section header's dim level (B41)", () => {
    threadsState = ready([
      thread({ id: "old", latestAttentionAt: BEFORE_MIDNIGHT - 3 * DAY }),
      thread({ id: "new", latestAttentionAt: BEFORE_MIDNIGHT }),
    ]);
    renderList();

    const expanded = screen.getByRole("button", { name: /last 7 days/i });
    const dim = expanded.className.match(/opacity-\d+/)?.[0];
    expect(dim).toBeDefined();

    fireEvent.click(expanded);
    expect(renderedIds()).toEqual(["new"]);
    expect(
      screen.getByRole("button", { name: /last 7 days/i }).className,
    ).toContain(dim);
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

describe("ThreadList — entrance order (B68)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BEFORE_MIDNIGHT);
  });

  it("holds a mounted row's index when its attention overtakes the row above it", () => {
    threadsState = ready([
      thread({ id: "a", latestAttentionAt: BEFORE_MIDNIGHT }),
      thread({ id: "b", latestAttentionAt: BEFORE_MIDNIGHT - MINUTE }),
    ]);
    const slot = renderList();
    expect(renderedIds()).toEqual(["a", "b"]);

    // `b` is touched and would out-sort `a` — with no pointer anywhere near the
    // list, which is the guarantee the freeze it replaces could not make.
    threadsState = ready([
      thread({ id: "a", latestAttentionAt: BEFORE_MIDNIGHT }),
      thread({ id: "b", latestAttentionAt: BEFORE_MIDNIGHT + MINUTE }),
    ]);
    slot.lifecycle.rerender(<ThreadList {...props()} />);
    expect(renderedIds()).toEqual(["a", "b"]);
  });

  it("lands a newly arriving thread at the top of its section, moving nothing below", () => {
    threadsState = ready([
      thread({ id: "a", latestAttentionAt: BEFORE_MIDNIGHT }),
      thread({ id: "b", latestAttentionAt: BEFORE_MIDNIGHT - MINUTE }),
    ]);
    const slot = renderList();
    expect(renderedIds()).toEqual(["a", "b"]);

    // The oldest attention of the three, and still first: the position comes
    // from when it entered TODAY, never from its timestamp.
    threadsState = ready([
      ...threadsState.threads,
      thread({ id: "fresh", latestAttentionAt: BEFORE_MIDNIGHT - 10 * MINUTE }),
    ]);
    slot.lifecycle.rerender(<ThreadList {...props()} />);
    expect(renderedIds()).toEqual(["fresh", "a", "b"]);
  });

  it("leaves the order unchanged after a project scope is applied and cleared (B68.5)", () => {
    threadsState = ready([
      thread({ id: "a", projectId: "p1", latestAttentionAt: BEFORE_MIDNIGHT }),
      thread({ id: "b", projectId: "p2", latestAttentionAt: BEFORE_MIDNIGHT - MINUTE }),
      thread({
        id: "c",
        projectId: "p1",
        latestAttentionAt: BEFORE_MIDNIGHT - 2 * MINUTE,
      }),
    ]);
    renderList();
    const before = renderedIds();
    expect(before).toEqual(["a", "b", "c"]);

    choose("Filter", "bb-plugins");
    expect(renderedIds()).toEqual(["a", "c"]);

    choose("Filter", "All projects");
    expect(renderedIds()).toEqual(before);
  });
});

describe("ThreadList — project scope filter (B64, B78)", () => {
  it("offers All projects, then every project by name (B64.1, B78.1)", () => {
    threadsState = ready([thread()]);
    renderList();
    expect(submenuItems("Filter")).toEqual(["All projects", "bb-plugins", "Beta"]);
  });

  it("names the project in the no-matches state when the scope is empty (B64.4)", () => {
    threadsState = ready([thread({ id: "a", projectId: "p1" })]);
    renderList();
    choose("Filter", "Beta");
    expect(screen.getByText(/no threads match/i).textContent).toContain("Beta");
    // Never the generic empty state, which would be a lie about this account.
    expect(screen.queryByText(/no threads yet/i)).toBeNull();
    // The control survives, so the scope that hid everything can be undone.
    expect(screen.getByLabelText("Display options")).toBeTruthy();
  });

  it("is present on a compact viewport too (B64.5, B76.4)", () => {
    threadsState = ready([thread()]);
    renderList({ isCompactViewport: true });
    openDisplayMenu();
    expect(screen.getByRole("menu", { name: "Display options" })).toBeTruthy();
  });

  it("keeps the scope out of storage, and resets it on remount (B64.2, B78.2)", () => {
    threadsState = ready([thread({ id: "a", projectId: "p1" })]);
    renderList();
    choose("Filter", "Beta");
    expect(renderedIds()).toEqual([]);
    expect(window.localStorage.length).toBe(0);

    cleanup();
    renderList();
    expect(checkedItem("Filter")).toBe("All projects");
    expect(renderedIds()).toEqual(["a"]);
  });

  /**
   * B78.2 is the whole point of the pairing: the two values share a menu and
   * nothing else. A grouping is a view preference worth keeping; a scope is a
   * filter you forgot you set, and it must not outlive the tab.
   */
  it("persists a grouping but never the scope (B77.2, B78.2)", () => {
    threadsState = ready([thread({ id: "a", projectId: "p1" })]);
    renderList();

    choose("Filter", "bb-plugins");
    expect(window.localStorage.length).toBe(0);

    choose("Group by", "Host");
    expect(window.localStorage.getItem("better-sidebar:group-by")).toBe('"host"');
    // Storing the grouping did not smuggle the scope in alongside it: the
    // grouping key is the only key in the store.
    expect(window.localStorage.length).toBe(1);
  });

  it("shows the active scope as a chip whose clear control restores it (B76.2)", () => {
    threadsState = ready([
      thread({ id: "a", projectId: "p1" }),
      thread({ id: "b", projectId: "p2" }),
    ]);
    renderList();
    // B76.3: the resting row is the trigger alone.
    expect(document.querySelector("[data-better-sidebar-scope-chip]")).toBeNull();

    choose("Filter", "Beta");
    expect(
      document.querySelector("[data-better-sidebar-scope-chip]")?.textContent,
    ).toContain("Beta");
    expect(renderedIds()).toEqual(["b"]);

    fireEvent.click(screen.getByLabelText(/clear project filter/i));
    expect(document.querySelector("[data-better-sidebar-scope-chip]")).toBeNull();
    expect(renderedIds()).toEqual(["a", "b"]);
  });
});

describe("ThreadList — grouping from the menu (B77)", () => {
  it("groups by the setting while nothing is stored (B77.3)", () => {
    threadsState = ready([thread({ id: "a", projectId: "p1" })]);
    renderList({}, { groupBy: "project" });
    expect(sectionLabels()[0]).toMatch(/bb-plugins/i);
    expect(checkedItem("Group by")).toBe("Project");
  });

  it("lets the stored value override the setting (B77.3)", () => {
    window.localStorage.setItem("better-sidebar:group-by", '"none"');
    threadsState = ready([thread({ id: "a", projectId: "p1" })]);
    renderList({}, { groupBy: "project" });
    expect(sectionLabels()[0]).not.toMatch(/bb-plugins/i);
    expect(checkedItem("Group by")).toBe("None");
  });

  it("falls back to the setting when the store holds a value outside the five (B77.4)", () => {
    window.localStorage.setItem("better-sidebar:group-by", '"bogus"');
    threadsState = ready([thread({ id: "a", projectId: "p1" })]);
    renderList({}, { groupBy: "project" });
    // The list still renders: a hand-edited store never blanks the sidebar.
    expect(renderedIds()).toEqual(["a"]);
    expect(sectionLabels()[0]).toMatch(/bb-plugins/i);
    expect(checkedItem("Group by")).toBe("Project");
  });

  it("re-groups in place, keeping collapse state and the mounted rows (B77.1)", () => {
    vi.setSystemTime(BEFORE_MIDNIGHT);
    threadsState = ready([
      thread({ id: "a", projectId: "p1", latestAttentionAt: BEFORE_MIDNIGHT - 3 * DAY }),
      thread({ id: "b", projectId: "p2", latestAttentionAt: BEFORE_MIDNIGHT }),
    ]);
    renderList({}, { groupBy: "date" });
    const scrollerBefore = document.querySelector("[data-better-sidebar-list]");
    // Collapse a section before re-grouping, so there is state to lose.
    fireEvent.click(screen.getAllByRole("button", { name: /last 7 days/i })[0]);
    expect(renderedIds()).toEqual(["b"]);

    choose("Group by", "Project");
    expect(sectionLabels().join(" ")).toMatch(/bb-plugins/i);
    // Same scroll container: the list re-grouped in place rather than
    // remounting, so scroll position survives the choice.
    expect(document.querySelector("[data-better-sidebar-list]")).toBe(scrollerBefore);
    expect(renderedIds()).toEqual(["a", "b"]);

    // Collapse state is keyed by section, so it is still there when the same
    // grouping comes back.
    choose("Group by", "Date");
    expect(renderedIds()).toEqual(["b"]);
  });

  it("offers the five values and nothing else (B65, B76.6)", () => {
    threadsState = ready([thread()]);
    renderList();
    expect(submenuItems("Group by")).toEqual([
      "Date",
      "Project",
      "Host",
      "Status",
      "None",
    ]);
  });
});

describe("ThreadList — host contract", () => {
  it("calls onNavigate and opens the thread when a row is clicked (B47)", () => {
    threadsState = ready([thread()]);
    const slot = renderList();

    // The row's click target is its `absolute inset-0` anchor overlay, which
    // is also B44's shortcut target; the title above it is transparent to the
    // pointer, so a real click lands here.
    const target = document.querySelector("[data-sidebar-thread-shortcut-target]");
    fireEvent.click(target!);

    expect(slot.inspection.sidebarActionCalls).toContainEqual(
      expect.objectContaining({ method: "open", threadId: "t1" }),
    );
    expect(onNavigate).toHaveBeenCalled();
  });

  /**
   * B32, asserted through what the user sees rather than through a provider
   * that no longer exists: `isCompactViewport` is a slot prop the list already
   * holds, so it reaches the dossier as a `RowHover` prop and the hover trigger
   * — the only thing that could open a dossier — is simply not attached.
   */
  it("attaches no hover trigger on a compact viewport (B32)", () => {
    threadsState = ready([thread()]);
    renderList({ isCompactViewport: true });
    expect(document.querySelector("[data-better-sidebar-hover-trigger]")).toBeNull();
  });

  it("attaches one on a regular viewport (B32)", () => {
    threadsState = ready([thread()]);
    renderList({ isCompactViewport: false });
    expect(
      document.querySelectorAll("[data-better-sidebar-hover-trigger]"),
    ).toHaveLength(1);
  });
});

describe("ThreadList — second row (B18, B19)", () => {
  /**
   * Row 2 only. The B64 scope control lists the same project names in its
   * options, so a document-wide text probe would report row 2 present on every
   * account that has a project.
   */
  function hasSecondRow(): boolean {
    return screen
      .queryAllByText("bb-plugins")
      .some((node) => node.closest("[data-better-sidebar-project-filter]") === null);
  }

  it.each([
    ["date", true],
    ["host", true],
    ["status", true],
    ["none", true],
    ["project", false],
  ] as const)("default shows row 2 under groupBy %s: %s", (groupBy, expected) => {
    threadsState = ready([thread()]);
    renderList({}, { groupBy, density: "default" });
    expect(hasSecondRow()).toBe(expected);
  });

  it.each(["date", "none", "project"] as const)(
    "detailed shows row 2 under groupBy %s, where default does not (B60)",
    (groupBy) => {
      threadsState = ready([thread()]);
      renderList({}, { groupBy, density: "detailed" });
      expect(hasSecondRow()).toBe(true);
    },
  );

  it.each(["date", "none", "project"] as const)(
    "compact hides row 2 under groupBy %s",
    (groupBy) => {
      threadsState = ready([thread()]);
      renderList({}, { groupBy, density: "compact" });
      expect(hasSecondRow()).toBe(false);
    },
  );

  it("still renders row 2 on a compact viewport (B19, B62.1)", () => {
    threadsState = ready([thread()]);
    renderList({ isCompactViewport: true });
    expect(hasSecondRow()).toBe(true);
  });

  it("obeys density detailed on a compact viewport too (B62.1)", () => {
    threadsState = ready([thread()]);
    renderList({ isCompactViewport: true }, { groupBy: "project", density: "detailed" });
    expect(hasSecondRow()).toBe(true);
  });
});

describe("ThreadList — a hidden thing costs nothing (B61)", () => {
  it("issues no rowSignals request and mounts no observer at density compact", () => {
    const observe = vi.spyOn(globalThis.IntersectionObserver.prototype, "observe");
    threadsState = ready([thread(), thread({ id: "t2" })]);

    const slot = renderList({}, { density: "compact" });

    expect(observe).toHaveBeenCalledTimes(0);
    expect(
      slot.inspection.rpcCalls.filter((call) => call.method === "rowSignals"),
    ).toHaveLength(0);
    expect(document.querySelectorAll("[data-better-sidebar-signals]")).toHaveLength(0);
    observe.mockRestore();
  });

  /**
   * B60.1 with amendment 7 in: the display menu writes `groupBy` to
   * `localStorage` precisely so that opening it and using it stays free of
   * backend traffic.
   */
  it("issues no rpc at all from mounting the list and opening the menu at compact", () => {
    threadsState = ready([thread(), thread({ id: "t2" })]);

    const slot = renderList({}, { density: "compact" });
    openDisplayMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Group by" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Host" }));

    expect(slot.inspection.rpcCalls).toHaveLength(0);
  });

  it("observes one signal cluster per row at density detailed (B60.2)", () => {
    const observe = vi.spyOn(globalThis.IntersectionObserver.prototype, "observe");
    threadsState = ready([thread(), thread({ id: "t2" })]);

    renderList({}, { density: "detailed" });

    expect(observe).toHaveBeenCalledTimes(2);
    observe.mockRestore();
  });

  it("draws no provider glyph and no time when their settings are off", () => {
    threadsState = ready([thread()]);
    renderList({}, { showProviderGlyph: "false", showRelativeTime: "false" });

    expect(document.querySelectorAll("[data-better-sidebar-provider]")).toHaveLength(0);
    expect(screen.getByText("Ship the sidebar")).not.toBeNull();
  });
});

/**
 * B73. One 8px column for the whole panel, carried by the scroll container.
 *
 * jsdom runs no layout, so `offsetLeft` is 0 everywhere and the edges cannot be
 * measured. The structural equivalent is asserted instead, and it is the
 * stronger claim: the inset exists in exactly one place. If the container holds
 * the only horizontal padding, then row 1, the section header and the filter
 * necessarily share both edges, because there is nothing else to shift them.
 */
describe("ThreadList — the host's 8px column (B73)", () => {
  /** Every horizontal-padding utility on a node: `p-`, `px-`, `pl-`, `pr-`. */
  function hPadding(node: Element | null): string[] {
    return (node?.getAttribute("class") ?? "")
      .split(/\s+/)
      .filter((token) => /^(p|px|pl|pr)-/.test(token));
  }

  const listBox = () => document.querySelector("[data-better-sidebar-list]");
  const headerBox = () => document.querySelector("[data-sidebar-section] h2, [data-sidebar-section] button");
  const rowBox = () =>
    document.querySelector("[data-better-sidebar-row]")?.firstElementChild ?? null;

  it("puts the inset on the scroll container and nowhere else (B73.1, B73.2, B73.4)", () => {
    threadsState = ready([thread()]);
    renderList();

    // Asserted once, from the container: this is the panel's only inset.
    expect(hPadding(listBox())).toEqual(["px-2"]);

    // Row 1, the section header and the filter each carry none of their own,
    // so all three inherit that single column — two insets in series would
    // have put the chrome at 16px and left the rows at 8px.
    expect(hPadding(rowBox())).toEqual([]);
    expect(hPadding(headerBox())).toEqual([]);
    expect(
      hPadding(document.querySelector("[data-better-sidebar-project-filter]")),
    ).toEqual([]);
  });

  /**
   * B73.3. Moving the column right must not reintroduce the per-row gutter
   * B57.3 removed, and must not disturb B9's per-depth indent. Depth 0 stays
   * flush; a child still steps in by one unit.
   */
  it("keeps a depth-0 row flush and still indents a child (B73.3, B9)", () => {
    threadsState = ready([
      thread(),
      thread({ id: "t2", parentThreadId: "t1" }),
    ]);
    renderList();

    const boxes = Array.from(
      document.querySelectorAll("[data-better-sidebar-row]"),
    ).map((node) => node.firstElementChild as HTMLElement);
    expect(boxes[0].style.paddingLeft).toBe("0px");
    expect(boxes[1].style.paddingLeft).toBe("12px");
  });
});
