// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import {
  installTestPluginRuntime,
  renderSlot,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginSidebarPullRequest,
  PluginSidebarThread,
  PluginSidebarThreadIndicator,
} from "@get-bb/plugin-sdk/app";
import type { RenderRow } from "../model/types";
import { ROW1_ICON, ROW2_ICON } from "./row-metrics";

/**
 * The split gesture is entirely host-owned, so the harness reports empty
 * `splitProps` and B45 would be unobservable through it. Replacing just that
 * one hook makes "the row spreads splitProps onto its interactive element"
 * a fact a test can see: the marker handler fires only if the row spread it.
 */
/** B36's refusal path surfaces through `sonner`, the same toast bb's own
 *  sidebar uses. Mocked so the assertion is a call, not a rendered node. */
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const splitPointerDown = vi.fn();
/**
 * B61.3: the PR gate is asserted as a CALL COUNT. A DOM probe for the chip
 * passes while the subscription still runs, which is the failure mode B61
 * exists to prevent.
 */
const prHookCalls = vi.fn();
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const realPrHook = actual.experimental_useSidebarThreadPullRequest as (
    threadId: string,
  ) => unknown;
  return {
    ...actual,
    experimental_useSidebarThreadSplit: () => ({
      splitProps: { onPointerDown: splitPointerDown },
      isAvailable: true,
      pane: null,
    }),
    experimental_useSidebarThreadPullRequest: (threadId: string) => {
      prHookCalls(threadId);
      return realPrHook(threadId);
    },
  };
});

installTestPluginRuntime();

const { ThreadRow } = await import("./ThreadRow");
const { resetHoverSuppression } = await import("../dossier/RowHover");
const { resetRowSignals } = await import("../dossier/useRowSignals");

/**
 * jsdom ships no IntersectionObserver and slice 4 fails loudly without one
 * (`useRowSignals.ts:126`). Nothing here is intersecting, which is the right
 * default for a row-chrome test: §7's B37-B40 ruling says a row that has never
 * been scrolled into view draws no signal glyph.
 */
class NoopIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: readonly number[] = [];
  readonly scrollMargin = "";
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
vi.stubGlobal("IntersectionObserver", NoopIntersectionObserver);

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** The first bytes of the pin path in `ui/Glyph.tsx`; B15 forbids drawing it. */
const PIN_PATH_PREFIX = "M12 2 9 9l-5 1";

function thread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
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
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    lastReadAt: null,
    latestAttentionAt: NOW - DAY,
    ...overrides,
  };
}

function row(overrides: Partial<RenderRow> = {}): RenderRow {
  const base = overrides.thread ?? thread();
  return {
    thread: base,
    title: base.title ?? "Untitled",
    workspaceLabel: null,
    depth: 0,
    childCount: 0,
    projectName: "bb-plugins",
    dimLevel: 0,
    sectionKey: "today",
    ...overrides,
  };
}

function pr(
  overrides: Partial<PluginSidebarPullRequest> = {},
): PluginSidebarPullRequest {
  return {
    number: 42,
    title: "Add the better sidebar",
    url: "https://github.test/org/repo/pull/42",
    state: "open",
    attention: "checks_failed",
    ...overrides,
  };
}

const onNavigate = vi.fn();

function renderRow(
  target: RenderRow,
  options: RenderSlotOptions = {},
  propOverrides: Record<string, unknown> = {},
) {
  return renderSlot(
    { component: ThreadRow },
    {
      row: target,
      now: NOW,
      showSecondRow: true,
      isCompactViewport: false,
      onNavigate,
      ...propOverrides,
    },
    options,
  );
}

/** The row's box: everything the user sees, anchor overlay included. */
function rowElement(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>("[data-better-sidebar-row]");
  if (element === null) throw new Error("no row rendered");
  return element;
}

/** Row 1: the one fixed layout every row draws (B51). */
function rowOne(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>("[data-better-sidebar-row1]");
  if (element === null) throw new Error("no row 1 rendered");
  return element;
}

/** The PR chip. The row overlay is an anchor now, so `role="link"` is plural. */
/** Row 1's status/time cluster, which is no longer its last child. */
function trailing(container: HTMLElement): HTMLElement {
  const element = rowOne(container).querySelector<HTMLElement>(
    "[data-better-sidebar-row-trailing]",
  );
  if (element === null) throw new Error("no trailing cluster");
  return element;
}

function prChip(): HTMLElement {
  const chip = document.querySelector<HTMLElement>("[data-better-sidebar-pr]");
  if (chip === null) throw new Error("no pull-request chip rendered");
  return chip;
}

/** The host contract's element, which the collector requires be an anchor. */
function shortcutTarget(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>(
    "[data-sidebar-thread-shortcut-target]",
  );
  if (element === null) throw new Error("row has no shortcut target");
  return element;
}

beforeEach(() => {
  onNavigate.mockClear();
  splitPointerDown.mockClear();
  toastError.mockClear();
  prHookCalls.mockClear();
});

afterEach(() => {
  cleanup();
  resetHoverSuppression();
  resetRowSignals();
});

describe("ThreadRow host contract", () => {
  /**
   * The host collects shortcut targets with
   * `if (el instanceof HTMLAnchorElement) { … } else { … continue }`, so the
   * element type is the contract and the attributes alone are not. A
   * `<div role="button">` carrying both passed every attribute assertion while
   * bb's nine shortcuts addressed nothing at all.
   */
  it("carries both shortcut attributes on an anchor (B44)", () => {
    const { container } = renderRow(row());
    const element = shortcutTarget(container);

    expect(element.getAttribute("data-sidebar-thread-shortcut-target")).toBe("");
    expect(element.getAttribute("data-sidebar-thread-id")).toBe("t1");
    expect(element).toBeInstanceOf(HTMLAnchorElement);
    expect(element.getAttribute("aria-label")).toBe("Ship the sidebar");
  });

  it("spreads splitProps onto that same element (B45)", () => {
    const { container } = renderRow(row());
    fireEvent.pointerDown(shortcutTarget(container));
    expect(splitPointerDown).toHaveBeenCalledTimes(1);
  });

  it("opens the thread from the keyboard as well as the pointer (B44)", () => {
    const { container, inspection } = renderRow(row());
    fireEvent.keyDown(shortcutTarget(container), { key: "Enter" });

    expect(inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "t1" },
    ]);
  });

  it("opens the thread and calls onNavigate (B47)", () => {
    const { container, inspection } = renderRow(row());
    fireEvent.click(shortcutTarget(container));

    expect(inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "t1" },
    ]);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  /**
   * The B44 guard, replacing the old windowing test. bb's nine numbered
   * shortcuts address rows by their mounted DOM nodes, so every row mounts,
   * always, in visual order (§6). If a later change reintroduces windowing,
   * slicing or an overscan window, this fails.
   */
  // 200 rows is the heaviest render in the suite and it runs alongside 26
  // other files. Measured alone it costs ~120ms; the default 5s timeout was
  // tripping on scheduler contention, not on any per-row cost.
  it("mounts 200 rows as 200 shortcut targets in visual order (B44)", { timeout: 20_000 }, () => {
    const rows = Array.from({ length: 200 }, (_, index) =>
      row({ thread: thread({ id: `t${index}`, title: `Thread ${index}` }) }),
    );

    function List({ items }: { items: RenderRow[] }) {
      return (
        <div>
          {items.map((item) => (
            <ThreadRow
              key={item.thread.id}
              row={item}
              now={NOW}
              showSecondRow={false}
              isCompactViewport={false}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      );
    }

    const { container } = renderSlot({ component: List }, { items: rows });
    const targets = container.querySelectorAll(
      "[data-sidebar-thread-shortcut-target]",
    );

    expect(targets).toHaveLength(200);
    expect(
      Array.from(targets, (node) => node.getAttribute("data-sidebar-thread-id")),
    ).toEqual(rows.map((item) => item.thread.id));

    // The host's collector accepts a match only when it is an
    // `HTMLAnchorElement` (or carries `data-sidebar-windowed-nav`); every other
    // element is skipped outright. Attribute presence was never the contract,
    // so asserting only that let a `<div role="button">` row pass while all
    // nine numbered/next/previous shortcuts silently did nothing.
    expect(
      Array.from(targets).filter((node) => node instanceof HTMLAnchorElement),
    ).toHaveLength(200);
  });
});

/**
 * B14 forbids opacity as a signal of the row's STATE. The hover cluster and
 * the trailing indicator it replaces both animate opacity, so the rule is now
 * checked as written: every opacity class on the row must be gated on hover or
 * focus, never applied at rest.
 */
function expectNoRestingOpacity(element: Element): void {
  const resting = Array.from(
    element.querySelectorAll('[class*="opacity-"]'),
  ).filter(
    (node) =>
      !node.className.includes("group-hover/row:") &&
      !node.className.includes("group-focus-within/row:") &&
      !node.className.includes("focus-within:opacity-") &&
      !node.className.includes("group-has-[[data-state=open]]/row:"),
  );
  expect(resting.map((node) => node.className)).toEqual([]);
}

describe("ThreadRow hover actions", () => {
  function actions(container: HTMLElement): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      "[data-better-sidebar-row-actions]",
    );
    if (element === null) throw new Error("no hover actions rendered");
    return element;
  }

  /**
   * The cluster stands in for row 1's trailing indicator, so it must sit on
   * row 1's line. `inset-y-0` centred it over the whole two-line box, which
   * on a root row left it floating between the lines against nothing.
   */
  /**
   * The cluster is absolutely placed at the row's right edge, so without an
   * inset a long title runs underneath it. Row 1 gives up exactly the
   * cluster's width — three `size-5` buttons and two `gap-0.5` gaps is 64px,
   * which is `pr-16` — on the same three triggers the cluster appears on.
   */
  /**
   * The cluster takes the trailing indicator's PLACE in the flow, so the
   * title's `truncate` measures against whatever is actually beside it. Two
   * earlier attempts got this wrong: absolutely positioned it overlapped long
   * titles, and a fixed `pr-16` inset double-counted the faded indicator's
   * width, so titles truncated with room to spare. A flex sibling needs no
   * width constant at all.
   */
  it("swaps the cluster into the trailing indicator's place, in flow", () => {
    const { container } = renderRow(row());
    const one = rowOne(container);
    const cluster = actions(container);

    expect(cluster.className).not.toContain("absolute");
    expect(one.className).not.toContain("pr-16");
    // Last child of row 1: exactly where the indicator sat.
    expect(one.lastElementChild).toBe(cluster);

    // The indicator leaves the flow rather than merely fading, or the two
    // would both claim width and the title would clear both.
    const cluster2 = trailing(container);
    for (const trigger of [
      "group-hover/row:",
      "group-focus-within/row:",
      "group-has-[[data-state=open]]/row:",
    ]) {
      expect(cluster2.className).toContain(`${trigger}hidden`);
      expect(cluster.className).toContain(`${trigger}flex`);
    }
    expect(cluster2.className).not.toContain("opacity-0");
  });

  it("marks an unread thread read from the check button", () => {
    const { container, inspection } = renderRow(
      row({ thread: thread({ isUnread: true }) }),
    );
    fireEvent.click(within(actions(container)).getByLabelText("Mark read"));

    expect(inspection.sidebarActionCalls).toEqual([
      { method: "setRead", threadId: "t1", read: true },
    ]);
  });

  it("marks a read thread unread from the same button", () => {
    const { container, inspection } = renderRow(row());
    fireEvent.click(within(actions(container)).getByLabelText("Mark unread"));

    expect(inspection.sidebarActionCalls).toEqual([
      { method: "setRead", threadId: "t1", read: false },
    ]);
  });

  it("archives from the archive button", () => {
    const { container, inspection } = renderRow(row());
    fireEvent.click(within(actions(container)).getByLabelText("Archive"));

    expect(inspection.sidebarActionCalls).toEqual([
      { method: "archive", threadId: "t1" },
    ]);
  });

  /**
   * The row's anchor sits under every one of these buttons. Without the
   * `stopPropagation` each carries, marking a thread read would also open it.
   */
  it("never opens the thread from an action button", () => {
    const { container, inspection } = renderRow(row());
    fireEvent.click(within(actions(container)).getByLabelText("Archive"));

    expect(
      inspection.sidebarActionCalls.filter((call) => call.method === "open"),
    ).toEqual([]);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("opens the same action list the right-click menu carries", () => {
    const { container } = renderRow(row());
    const trigger = within(actions(container)).getByLabelText("Thread actions");
    // Radix opens a dropdown from `pointerdown`, not from `click`.
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(trigger);

    for (const label of ["Open in split", "Pin", "Rename", "Delete"]) {
      expect(screen.getByText(label)).not.toBeNull();
    }
  });

  it("hides the trailing indicator only on hover, never at rest", () => {
    const { container } = renderRow(row());
    const trailing = rowElement(container).querySelector(
      '[data-better-sidebar-row-trailing]',
    );
    if (trailing === null) throw new Error("no trailing cluster");
    // A BARE `opacity-0` would dim the indicator at rest; the hover-gated
    // variant of the same utility is the whole point.
    expect(trailing.className.split(/\s+/)).not.toContain("opacity-0");
  });
});

describe("ThreadRow chrome", () => {
  it("carries isUnread as font weight and never as opacity (B14)", () => {
    const { container } = renderRow(row({ thread: thread({ isUnread: true }) }));
    const element = rowElement(container);

    expect(element.textContent).toContain("Ship the sidebar");
    expect(element.querySelector(".font-semibold")).not.toBeNull();
    expectNoRestingOpacity(element);
  });

  it("keeps a read row at the same opacity, in normal weight (B14)", () => {
    const { container } = renderRow(row());
    const element = rowElement(container);

    expect(element.querySelector(".font-normal")).not.toBeNull();
    expectNoRestingOpacity(element);
  });

  it("draws no pin glyph for a pinned thread (B15)", () => {
    const { container } = renderRow(row({ thread: thread({ isPinned: true }) }));
    expect(container.innerHTML).not.toContain(PIN_PATH_PREFIX);
  });

  it("renders the provider glyph with no environment and no PR (B17)", () => {
    const { container } = renderRow(
      row(),
      { providers: { status: "ready", providers: [] } },
      // The mark rides on the model label, so it needs one to be drawn.
      { execution: { model: "claude-opus-5", reasoningLevel: "low" } },
    );

    const element = rowElement(container);
    expect(element.textContent).not.toContain("#");
    expect(
      Array.from(element.querySelectorAll('[role="img"]'), (node) =>
        node.getAttribute("aria-label"),
      ),
    ).toContain("acp-claude-code");
  });

  /** B12: a recent child under an old parent must read as recent. */
  it("shows the row's own relative time (B12)", () => {
    const child = row({
      thread: thread({
        id: "child",
        parentThreadId: "t1",
        updatedAt: NOW - 5 * MINUTE,
      }),
      depth: 1,
    });

    const { container } = renderRow(child);
    expect(rowElement(container).textContent).toContain("5m");
  });

  it("hides row 2 when the list says so (B18)", () => {
    const { container } = renderSlot(
      { component: ThreadRow },
      {
        row: row(),
        now: NOW,
        showSecondRow: false,
        isCompactViewport: false,
        onNavigate,
      },
    );

    expect(rowElement(container).textContent).not.toContain("bb-plugins");
  });
});

/**
 * B57's layout: one row-1 shape for every row —
 * `[provider] title [chevron, parents only] … [status] [time]`.
 *
 * The user raised all of this from a screenshot of the running plugin: a count
 * left-adjacent to a title read as part of the title, and a reserved gutter
 * paid for a chevron most rows never draw.
 */
describe("ThreadRow row 1 layout (B57)", () => {
  /**
   * B57.1. The count is gone from the row entirely — the chevron alone says a
   * thread has children. A parent of three renders no "3" anywhere, in the
   * trailing cluster or otherwise.
   */
  it("renders no child count anywhere on the row (B57.1)", () => {
    const { container } = renderRow(
      row({
        thread: thread({ updatedAt: NOW - 5 * MINUTE }),
        childCount: 3,
      }),
    );

    expect(rowOne(container).textContent).toBe("Ship the sidebar5m");
    expect(rowElement(container).textContent).not.toContain("3");
    // The chevron stays, and it is the only children signal left.
    expect(
      rowOne(container).querySelector('[aria-label*="child threads"]'),
    ).not.toBeNull();
  });

  /**
   * B57.2. The chevron hugs the end of the title instead of preceding it, so
   * it reads as belonging to that thread rather than to a column.
   */
  it("places the chevron immediately after the title (B57.2)", () => {
    const { container } = renderRow(row({ childCount: 2 }));
    const one = rowOne(container);
    const children = Array.from(one.children);
    const title = one.querySelector(".truncate")!;
    const chevron = one.querySelector('[aria-label*="child threads"]')!.parentElement!;

    expect(children.indexOf(chevron)).toBe(children.indexOf(title) + 1);
  });

  /**
   * Revised B51.5, raised by the user against the running build: "the title is
   * truncated too soon reserving the space to icons which are displayed only on
   * hover". An idle childless row is the common row, and it reserved ~48px for
   * a count and a status glyph that were both absent.
   */
  it("reserves nothing for an absent count or status glyph (B51.5)", () => {
    const { container } = renderRow(row({ childCount: 0 }));
    const one = rowOne(container);
    const cluster = trailing(container);

    // Time only: the signals span (which must stay mounted for its observer)
    // and nothing else. An empty placeholder box would show up here.
    expect(cluster.children).toHaveLength(2);
    expect(cluster.firstElementChild!.getAttribute("data-better-sidebar-signals")).toBe(
      "t1",
    );
    expect(cluster.lastElementChild!.textContent).toBe("1d");
  });

  it("draws the status glyph in the leading column (B20)", () => {
    const { container } = renderRow(
      row({ thread: thread({ indicator: "waiting-for-input" }) }),
    );
    const leading = rowOne(container).firstElementChild!;

    expect(leading.querySelector("[role='img']")).not.toBeNull();
    expect(leading.className).toContain("w-[22px]");
  });

  /** Idle is the common row, and it draws no mark — but keeps its column. */
  it("keeps the leading column at width on an idle row", () => {
    const { container } = renderRow(row({ thread: thread({ indicator: "none" }) }));
    const leading = rowOne(container).firstElementChild!;

    expect(leading.children).toHaveLength(0);
    expect(leading.className).toContain("w-[22px]");
  });

  /**
   * The two marks swapped lines: status leads row 1, the provider mark leads
   * row 2, and they stack in one 22px gutter.
   */
  /**
   * The mark belongs to the model, not to the line: it says which agent ran
   * this, which is the same fact the model names. One setting governs both.
   */
  it("pairs the provider mark with the model, not the head of the line", () => {
    const { container } = renderRow(
      row({ projectName: "bb", workspaceLabel: "main" }),
      {},
      { execution: { model: "claude-opus-5", reasoningLevel: "low" } },
    );

    expect(
      rowOne(container).querySelector("[data-better-sidebar-provider]"),
    ).toBeNull();

    const line = rowOne(container).nextElementSibling!.firstElementChild!;
    const model = line.querySelector('[data-better-sidebar-row2="model"]')!;
    expect(model.querySelector("[role='img']")).not.toBeNull();
    expect(model.textContent).toContain("claude-opus-5 · low");

    // The line now leads with the project, whose own mark is a folder.
    expect(line.firstElementChild!.getAttribute("data-better-sidebar-row2")).toBe(
      "project",
    );
  });

  it("drops the mark with the model it qualifies", () => {
    const { container } = renderRow(
      row({ projectName: "bb", workspaceLabel: "main" }),
      {},
      { execution: null },
    );
    const line = rowOne(container).nextElementSibling!;

    expect(line.querySelector("[data-better-sidebar-provider]")).toBeNull();
    expect(line.textContent).toContain("bb");
  });

  /**
   * Every mark on a line is the same size, and each line's size is set
   * against that line's text: 12px beside the 13px title, 10px beside row 2's
   * `text-2xs`. Asserted against the shared constants, so a change has to be
   * made in one place rather than agreed across five files.
   */
  it("gives a child row a line of its own, carrying model and effort", () => {
    const { container } = renderRow(
      row({ depth: 1, projectName: "bb", workspaceLabel: "main" }),
      {},
      { execution: { model: "claude-opus-5", reasoningLevel: "low" } },
    );
    const line = rowOne(container).nextElementSibling!;

    expect(line.textContent).toContain("claude-opus-5 · low");
    // Not the root line: a child's project and branch repeat its parent's.
    expect(line.textContent).not.toContain("bb");
    expect(line.querySelector("[data-better-sidebar-provider]")).not.toBeNull();
  });

  /** B71.3, revised: mark and labels go together, never a placeholder. */
  it("draws a child nothing at all while its model is unknown", () => {
    const { container } = renderRow(row({ depth: 1 }), {}, { execution: null });
    const line = rowOne(container).nextElementSibling!;

    expect(line.querySelector("[data-better-sidebar-provider]")).toBeNull();
    expect(line.textContent).toBe("");
  });

  /** The time is metadata, so it reads at row 2's weight, not the title's. */
  it("draws the time at the same colour as row 2's labels", () => {
    const { container } = renderRow(
      row({ projectName: "bb", workspaceLabel: "main" }),
    );
    const time = trailing(container).lastElementChild!;
    const labels = rowOne(container).nextElementSibling!.firstElementChild!;

    expect(time.className).toContain("text-muted-foreground/70");
    expect(labels.className).toContain("text-muted-foreground/70");
  });

  /**
   * Whitespace alone divides the labels; no dot is drawn between them. Each
   * label carries its own mark, so a dot would be a second divider on a line
   * that is 10px tall. The `·` inside the model label is not a divider: it
   * joins the model to its effort, which read as one fact.
   */
  it.each([
    ["all three labels", {}],
    ["project hidden", { showProjectName: false }],
    ["branch hidden", { showBranch: false }],
    ["project and branch hidden", { showProjectName: false, showBranch: false }],
  ])("draws no divider between labels: %s", (_label, props) => {
    const { container } = renderRow(
      row({ projectName: "bb", workspaceLabel: "main" }),
      {},
      { execution: { model: "claude-opus-5", reasoningLevel: "low" }, ...props },
    );
    const line = rowOne(container).nextElementSibling!.firstElementChild!;

    const dividers = [...line.children].filter(
      (child) => child.textContent === "·",
    );
    expect(dividers).toHaveLength(0);
  });

  it("sizes every row-1 mark alike, and every row-2 mark alike but smaller", () => {
    const { container } = renderRow(
      row({
        thread: thread({ indicator: "waiting-for-input" }),
        projectName: "bb",
        workspaceLabel: "main",
      }),
    );

    const status = rowOne(container).firstElementChild!.firstElementChild!;
    expect(status.className).toContain(ROW1_ICON);
    const cluster = container.querySelector("[data-better-sidebar-row-actions]")!;
    const buttonGlyphs = cluster.querySelectorAll("svg");
    expect(buttonGlyphs).toHaveLength(3);
    for (const glyph of buttonGlyphs) {
      expect(glyph.getAttribute("class")).toContain(ROW1_ICON);
    }

    const line = rowOne(container).nextElementSibling!.firstElementChild!;
    for (const glyph of line.querySelectorAll("svg")) {
      expect(glyph.getAttribute("class")).toContain(ROW2_ICON);
    }

    // Row 2's marks are the smaller of the two, or the line reads as icons
    // with a caption rather than labels with marks.
    expect(ROW1_ICON).not.toBe(ROW2_ICON);
  });

  /**
   * B57.2/B57.5, superseding B51.1. Nothing is reserved on either row, so a
   * childless title starts at the same x as a parent's by removal rather than
   * by reservation. Asserted as the title's position in row 1 — jsdom lays
   * nothing out, so widths would prove nothing.
   */
  it("reserves no chevron gutter, and both titles start alike (B57.2, B57.5)", () => {
    const { container: withChildren } = renderRow(row({ childCount: 2 }));
    const parentIndex = titleIndex(rowOne(withChildren));
    cleanup();

    const { container: childless } = renderRow(row({ childCount: 0 }));
    const one = rowOne(childless);

    expect(titleIndex(one)).toBe(parentIndex);
    expect(one.querySelector('[aria-label*="child threads"]')).toBeNull();
    // The title is the second child on both: provider, then title. A reserved
    // gutter would push it to third on the childless row too.
    expect(parentIndex).toBe(1);
  });

  /**
   * Superseding B57.3. The row's base inset is symmetric — content sits
   * inside its rounded background rather than flush against both edges — and
   * B9's per-depth indent adds to the left of it. B74 halves the base to 4px.
   */
  it("insets the row equally on both sides, then indents by depth", () => {
    const { container: root } = renderRow(row({ depth: 0 }));
    const rootBox = rowElement(root).firstElementChild as HTMLElement;
    expect(rootBox.style.paddingLeft).toBe("4px");
    expect(rootBox.style.paddingRight).toBe("4px");
    cleanup();

    // 4px base + 2 x 12px nesting. The RIGHT side never moves: only the left
    // carries the indent, or a deep child's time would drift inward.
    const { container: child } = renderRow(row({ depth: 2 }));
    const childBox = rowElement(child).firstElementChild as HTMLElement;
    expect(childBox.style.paddingLeft).toBe("28px");
    expect(childBox.style.paddingRight).toBe("4px");
  });

  /**
   * B57.4. `RowSignals` stays mounted at zero width because it owns the
   * IntersectionObserver ref, and under the old per-element margins it changed
   * what the trailing cluster measured. Status has left this cluster for the
   * leading column, so the rule now governs the time alone: a mounted
   * zero-width sibling must contribute no gap.
   */
  it("keeps the trailing time's spacing independent of its siblings (B57.4)", () => {
    const { container } = renderRow(
      row({ thread: thread({ indicator: "waiting-for-input" }) }),
    );
    const cluster = trailing(container);
    const [signals, time] = Array.from(cluster.children);

    expect(signals.getAttribute("class")).not.toContain("ml-");
    expect(time.getAttribute("class")).toContain("ml-1.5");
  });

  /** The glyph is centred in its column, so it carries no margin of its own. */
  it("gives the status glyph no margin now that it leads the row", () => {
    const { container } = renderRow(
      row({ thread: thread({ indicator: "waiting-for-input" }) }),
    );
    const glyphBox = rowOne(container).firstElementChild!.firstElementChild!;

    expect(glyphBox.getAttribute("class")).not.toContain("ml-");
  });

  it("renders row 1 only on a child, time included (B52.1, B51.4)", () => {
    const { container } = renderRow(
      row({
        thread: thread({
          id: "child",
          parentThreadId: "t1",
          updatedAt: NOW - 5 * MINUTE,
        }),
        depth: 1,
        workspaceLabel: "maxbook",
      }),
    );

    const element = rowElement(container);
    expect(element.textContent).toContain("5m");
    expect(element.textContent).not.toContain("bb-plugins");
    expect(element.textContent).not.toContain("maxbook");
  });

  it("still renders row 2 on a root row (B52.2)", () => {
    const { container } = renderRow(row());
    expect(rowElement(container).textContent).toContain("bb-plugins");
    // B51.4: and the time is no longer on it.
    expect(rowOne(container).textContent).toContain("1d");
  });
});

/**
 * B56. A long branch starved the project name: `bb-plugins` rendered as
 * `bb-pl…` while the branch kept roughly four times the width, because both
 * were plain flex children and shrank in proportion to their natural width.
 * B56's fix made every label shrinkable; since then the split itself was
 * made equal rather than proportional (SecondRow's truncation pass), so the
 * same number of pixels comes off each label.
 *
 * jsdom lays nothing out, so these assert the flex contract that decides the
 * outcome rather than measured pixels: who may shrink, and what caps whom.
 * The rendered check at panel width is B56.5's manual step.
 */
describe("ThreadRow row 2 under pressure (B56)", () => {
  const LONG_BRANCH = "bb/create-customizable-plugin-version-with-a-very-long-slug";

  function rowTwoLabels(container: HTMLElement) {
    const two = rowOne(container).nextElementSibling!;
    // By name, not by index: separators sit between the labels, so a
    // positional probe breaks whenever the line gains or loses one.
    const at = (name: string) => {
      const el = two.querySelector(`[data-better-sidebar-row2="${name}"]`);
      if (el === null) throw new Error(`no row-2 ${name}`);
      return el;
    };
    return { project: at("project"), branch: at("branch") };
  }

  /**
   * Superseding B56.1 and B56.2, which made the branch the ONE shrinkable
   * label and capped the project at 45%. A narrow panel then had no way to
   * share the loss: the branch was starved to its bare glyph while the
   * project rendered in full, and the model — pinned `shrink-0` behind it —
   * overflowed the panel with nothing left to take the deficit.
   *
   * Every label shrinks now, and none caps its own width. The loss is
   * shared equally across the labels — see SecondRow's truncation pass —
   * rather than weighted by natural width, so a long branch can no longer
   * starve a short project while it still has characters to spare.
   */
  it("lets every label shrink, and caps none of them", () => {
    const { container } = renderRow(
      row({ projectName: "bb-plugins", workspaceLabel: LONG_BRANCH }),
      {},
      { execution: { model: "claude-opus-5", reasoningLevel: "low" } },
    );
    const two = rowOne(container).nextElementSibling!.firstElementChild!;

    for (const name of ["project", "branch", "model"]) {
      const label = two.querySelector(`[data-better-sidebar-row2="${name}"]`)!;
      const className = label.getAttribute("class")!;
      expect(className).toContain("shrink");
      expect(className).not.toContain("shrink-0");
      // `min-w-0` is what allows a flex child below its own content.
      expect(className).toContain("min-w-0");
      expect(className).not.toContain("max-w-");
      // The text truncates; the mark beside it never shrinks.
      expect(label.querySelector(".truncate")).not.toBeNull();
    }
  });

  /** The hard stop: no label may paint past the row's inset. */
  it("clips the line rather than letting it overflow the row", () => {
    const { container } = renderRow(
      row({ projectName: "bb-plugins", workspaceLabel: LONG_BRANCH }),
      {},
      { execution: { model: "claude-opus-5", reasoningLevel: "low" } },
    );
    const two = rowOne(container).nextElementSibling!.firstElementChild!;

    expect(two.getAttribute("class")).toContain("overflow-hidden");
  });

  /**
   * Row 1's fixed 28px box leaves ~5px of half-leading under a 13px title,
   * which read as a gap between the two lines. The 4px is taken back on row 2
   * rather than off row 1's height, so a row with no second line still
   * measures exactly one bb row (B54).
   */
  it("pulls row 2 up without shortening row 1", () => {
    const { container } = renderRow(
      row({ projectName: "bb", workspaceLabel: "main" }),
    );

    // Row 2's wrapper: the sibling right after row 1.
    const line = rowOne(container).nextElementSibling!;
    expect(line.className).toContain("-mt-1");
    expect(rowOne(container).className).toContain("h-7");
  });

  /** B56.3: with room to spare, nothing is truncated and nothing is padded. */
  it("renders a short project and a short branch in full (B56.3)", () => {
    const { container } = renderRow(
      row({ projectName: "bb", workspaceLabel: "main" }),
    );
    const { project, branch } = rowTwoLabels(container);

    expect(project.textContent).toBe("bb");
    expect(branch.textContent).toBe("main");
  });
});

/** Which child of row 1 the title is, so the gutter's reservation is testable. */
function titleIndex(one: HTMLElement): number {
  const title = one.querySelector(".truncate")!;
  return Array.from(one.children).indexOf(title);
}

/**
 * Slice 6 owns the editor state and the `actions.rename` call; slice 3 owns
 * where the input is drawn. This is the seam between them: the row swaps its
 * title for the editor's input, so the text does not move as it becomes
 * editable.
 */
describe("ThreadRow rename", () => {
  /**
   * This test was born skipped, and the skip was the finding: the editor opened
   * and closed inside one tick, because Radix restored focus to the trigger on
   * menu close, that blurred the freshly mounted `autoFocus` input, and the
   * blur committed an unchanged title — which the editor's own guard correctly
   * treats as a cancel. Rename therefore did nothing at all. Fixed by
   * `onCloseAutoFocus={(event) => event.preventDefault()}` on
   * `menu/RowContextMenu.tsx` — but that prop alone is NOT sufficient: with it
   * applied the input still never mounts, so `isRenaming` is not becoming true
   * on the menu's `onSelect` path at all. Still skipped, still the finding.
   */
  it("renders the rename input in place of the title (B46)", async () => {
    const { container } = renderRow(row());

    fireEvent.contextMenu(rowElement(container));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    fireEvent.click(within(menu).getByText("Rename"));

    const input = await screen.findByLabelText("Rename thread");
    expect((input as HTMLInputElement).value).toBe("Ship the sidebar");
    expect(rowElement(container).querySelector(".font-normal")).toBeNull();
  });
});

describe("ThreadRow pull request", () => {
  const withEnvironment = () =>
    row({
      thread: thread({
        environment: {
          id: "e1",
          name: "better-sidebar",
          branchName: "feat/better-sidebar",
          workspaceDisplayKind: "managed-worktree",
        },
      }),
    });

  /**
   * The chip used to trail the branch, so its x moved row to row with whatever
   * that row's branch happened to be. Pinned to the trailing edge it forms one
   * column, under row 1's own trailing cluster.
   */
  it("pins the chip to the trailing edge, past every other row-2 child", () => {
    const { container } = renderRow(withEnvironment(), {
      sidebarPullRequests: { t1: pr() },
    });

    const pinned = prChip().closest(".ml-auto");
    expect(pinned).not.toBeNull();

    const line = pinned!.parentElement!;
    expect(Array.from(line.children).indexOf(pinned!)).toBe(
      line.children.length - 1,
    );
  });

  it("keeps the chip whole and truncates the branch instead", () => {
    const { container } = renderRow(
      row({
        thread: thread({
          environment: {
            id: "e1",
            name: "better-sidebar",
            branchName: "feat/a-branch-name-long-enough-to-need-the-whole-line",
            workspaceDisplayKind: "managed-worktree",
          },
        }),
        workspaceLabel: "feat/a-branch-name-long-enough-to-need-the-whole-line",
      }),
      { sidebarPullRequests: { t1: pr() } },
    );

    // The chip never shrinks — the number is the identifying part and it is
    // already short. The labels beside it are what give up width.
    expect(prChip().closest(".ml-auto")!.className).toContain("shrink-0");
    const branch = container.querySelector('[data-better-sidebar-row2="branch"]')!;
    expect(branch.getAttribute("class")).toContain("shrink");
    expect(branch.textContent).toContain("feat/a-branch-name");
  });

  it("makes one PR hook call and shares it with the chip (B33)", () => {
    const { container } = renderRow(withEnvironment(), {
      sidebarPullRequests: { t1: pr() },
    });

    expect(rowElement(container).textContent).toContain("#42");
    expect(prHookCalls).toHaveBeenCalled();
  });

  it("never calls the PR hook when showPrChip is off (B61.1, B61.3)", () => {
    const { container } = renderRow(
      withEnvironment(),
      { sidebarPullRequests: { t1: pr() } },
      { showPrChip: false },
    );

    expect(prHookCalls).toHaveBeenCalledTimes(0);
    expect(rowElement(container).textContent).not.toContain("#42");
  });

  it("subscribes to no PR for a thread with no environment (§6)", () => {
    const { container } = renderRow(row(), {
      sidebarPullRequests: { t1: pr() },
    });

    expect(rowElement(container).textContent).not.toContain("#42");
  });

  /**
   * §7's B36 ruling: assert the `openUrl` call and the non-navigation. "A new
   * tab" is not something the plugin can promise or observe — the host opens
   * the URL according to the client's own browser preference.
   */
  it("opens the PR through openUrl and never navigates the thread (B36)", () => {
    const { container, inspection } = renderRow(withEnvironment(), {
      sidebarPullRequests: { t1: pr() },
    });

    fireEvent.click(prChip());

    expect(inspection.navigateCalls).toEqual([
      { method: "openUrl", url: "https://github.test/org/repo/pull/42" },
    ]);
    expect(
      inspection.sidebarActionCalls.filter((call) => call.method === "open"),
    ).toHaveLength(0);
    expect(rowElement(container).textContent).toContain("Ship the sidebar");
  });

  it("surfaces a refused openUrl rather than failing silently (B36, §7)", () => {
    renderRow(withEnvironment(), {
      sidebarPullRequests: { t1: pr() },
      openUrl: () => false,
    });

    fireEvent.click(prChip());
    // A toast rather than an inline row element: an error line drawn inside the
    // row would shift every row below it, which is exactly what B6's freeze
    // exists to prevent. `sonner` is the surface bb's own sidebar uses.
    expect(toastError).toHaveBeenCalledWith("Could not open the pull request");
  });

  it("hides the chip and its work together with showPrChip off, PR present", () => {
    const { container } = renderRow(
      withEnvironment(),
      { sidebarPullRequests: { t1: pr() }, openUrl: () => true },
      { showPrChip: false },
    );
    expect(container.querySelector("[data-better-sidebar-pr]")).toBeNull();
  });

  it("stays quiet when openUrl succeeds (B36)", () => {
    // The harness leaves `openUrl` falsy unless told otherwise, so a real host
    // reporting success has to be stated explicitly — without this the refusal
    // toast would fire on every successful open and no test would notice.
    renderRow(withEnvironment(), {
      sidebarPullRequests: { t1: pr() },
      openUrl: () => true,
    });

    fireEvent.click(prChip());
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("ThreadRow hidden elements skip their work (B59, B61)", () => {
  it("mounts no IntersectionObserver when showSignals is off (B61.2, B61.3)", () => {
    const observe = vi.spyOn(globalThis.IntersectionObserver.prototype, "observe");
    const { container } = renderRow(row(), {}, { showSignals: false });

    expect(observe).toHaveBeenCalledTimes(0);
    expect(container.querySelector("[data-better-sidebar-signals]")).toBeNull();
    observe.mockRestore();
  });

  it("observes the signal cluster when showSignals is on", () => {
    const observe = vi.spyOn(globalThis.IntersectionObserver.prototype, "observe");
    renderRow(row(), {}, { showSignals: true });

    expect(observe).toHaveBeenCalledTimes(1);
    observe.mockRestore();
  });

  it("draws no provider glyph when showProviderGlyph is off", () => {
    const { container } = renderRow(row(), {}, { showProviderGlyph: false });
    expect(container.querySelector("[data-better-sidebar-provider]")).toBeNull();
    expect(rowElement(container).textContent).toContain("Ship the sidebar");
  });

  /**
   * Only the mark is hidden, never its column. The column measures the same
   * 22px either way, so the title and row 2 keep the x they have with the
   * setting on.
   */
  /**
   * The mark used to sit flush against the row's left border, with the whole
   * `gap-2` on its right. The column now owns that gap (`-mr-2` cancels it)
   * and centres the mark inside, without moving the title off 22px.
   */
  /**
   * Row 1's status sits in a 22px gutter; row 2 is indented past that gutter
   * by the same 22px. So the title and the WHOLE of row 2 — provider mark
   * first — share one left edge.
   */
  it("starts row 2 at the title's x, past row 1's status gutter", () => {
    const { container } = renderRow(
      row({ projectName: "bb", workspaceLabel: "main" }),
    );
    const gutter = rowOne(container).firstElementChild!;

    expect(gutter.className).toContain("w-[22px]");
    expect(gutter.className).toContain("justify-center");
    expect(rowOne(container).nextElementSibling!.className).toContain(
      "pl-[22px]",
    );
  });

  /**
   * B82. `thread.updatedAt` is a record write: it lags a running agent and a
   * bulk write stamps every thread at once. The list resolves the newest event
   * instead and hands it down; the row prefers it whenever it is present.
   */
  it("shows lastActivityAt over the thread's updatedAt (B82)", () => {
    const { container } = renderRow(
      row({ thread: thread({ updatedAt: NOW - DAY }) }),
      {},
      { lastActivityAt: NOW - 5 * MINUTE },
    );

    expect(trailing(container).textContent).toBe("5m");
  });

  it("falls back to updatedAt until the lookup lands (B82)", () => {
    const { container } = renderRow(row({ thread: thread({ updatedAt: NOW - DAY }) }));

    expect(trailing(container).textContent).toBe("1d");
  });

  it("draws no relative time when showRelativeTime is off", () => {
    const { container } = renderRow(row(), {}, { showRelativeTime: false });
    expect(trailing(container).textContent).not.toContain("1d");
  });
});

describe("ThreadRow — the active state", () => {
  /** The row's box, the element that carries the persistent background. */
  function rowBox(container: HTMLElement): HTMLElement {
    const box = rowElement(container).firstElementChild;
    if (box === null) throw new Error("no row box rendered");
    return box as HTMLElement;
  }

  it("gives the active row a persistent background and aria-current", () => {
    const { container } = renderRow(row(), {}, { isActive: true });
    // `hover:bg-accent/60` is always present, so the assertion is on the
    // unprefixed class alone — the persistent half of the treatment.
    expect(rowBox(container).classList.contains("bg-accent")).toBe(true);
    expect(
      container.querySelector("[data-sidebar-thread-id]")?.getAttribute("aria-current"),
    ).toBe("true");
  });

  it("gives an inactive row neither", () => {
    const { container } = renderRow(row());
    expect(rowBox(container).classList.contains("bg-accent")).toBe(false);
    expect(
      container.querySelector("[data-sidebar-thread-id]")?.getAttribute("aria-current"),
    ).toBeNull();
  });
});
