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
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    experimental_useSidebarThreadSplit: () => ({
      splitProps: { onPointerDown: splitPointerDown },
      isAvailable: true,
      pane: null,
    }),
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

function renderRow(target: RenderRow, options: RenderSlotOptions = {}) {
  return renderSlot(
    { component: ThreadRow },
    {
      row: target,
      now: NOW,
      showSecondRow: true,
      isCompactViewport: false,
      onNavigate,
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
  it("mounts 200 rows as 200 shortcut targets in visual order (B44)", () => {
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

describe("ThreadRow chrome", () => {
  it("carries isUnread as font weight and never as opacity (B14)", () => {
    const { container } = renderRow(row({ thread: thread({ isUnread: true }) }));
    const element = rowElement(container);

    expect(element.textContent).toContain("Ship the sidebar");
    expect(element.querySelector(".font-semibold")).not.toBeNull();
    expect(element.querySelectorAll('[class*="opacity-"]')).toHaveLength(0);
  });

  it("keeps a read row at the same opacity, in normal weight (B14)", () => {
    const { container } = renderRow(row());
    const element = rowElement(container);

    expect(element.querySelector(".font-normal")).not.toBeNull();
    expect(element.querySelectorAll('[class*="opacity-"]')).toHaveLength(0);
  });

  it("draws no pin glyph for a pinned thread (B15)", () => {
    const { container } = renderRow(row({ thread: thread({ isPinned: true }) }));
    expect(container.innerHTML).not.toContain(PIN_PATH_PREFIX);
  });

  it("renders the provider glyph with no environment and no PR (B17)", () => {
    const { container } = renderRow(row(), {
      providers: {
        status: "ready",
        providers: [],
      },
    });

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
 * The amendment's layout: one row-1 shape for every row —
 * `[chevron gutter] [provider] title … [child count] [status] [time]`.
 *
 * The user raised all of this from a screenshot of the running plugin: a count
 * left-adjacent to a title read as part of the title, and titles with and
 * without a chevron did not start on the same line.
 */
describe("ThreadRow row 1 layout (B51-B53)", () => {
  it("orders the trailing cluster count, status, then time (B51.3, B53.2)", () => {
    const { container } = renderRow(
      row({
        thread: thread({ updatedAt: NOW - 5 * MINUTE }),
        childCount: 3,
      }),
    );

    // The count follows the title and precedes the time; nothing precedes the
    // title but the gutter and the glyph, neither of which renders text.
    expect(rowOne(container).textContent).toBe("Ship the sidebar35m");
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
    const cluster = one.lastElementChild!;

    // Time only: the signals span (which must stay mounted for its observer)
    // and nothing else. An empty placeholder box would show up here.
    expect(cluster.children).toHaveLength(2);
    expect(cluster.firstElementChild!.getAttribute("data-better-sidebar-signals")).toBe(
      "t1",
    );
    expect(cluster.lastElementChild!.textContent).toBe("1d");
  });

  it("still draws the status glyph when the indicator says something (B20)", () => {
    const { container } = renderRow(
      row({ thread: thread({ indicator: "waiting-for-input" }) }),
    );
    expect(rowOne(container).lastElementChild!.children).toHaveLength(3);
  });

  it("draws the provider glyph immediately left of the title (B51.2)", () => {
    const { container } = renderRow(row());
    const one = rowOne(container);
    const provider = one.querySelector("[data-better-sidebar-provider]")!;
    const title = one.querySelector(".truncate")!;

    expect(provider.compareDocumentPosition(title)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  /**
   * B51.1. The gutter is reserved whether or not the row has children, so a
   * childless title starts on the same vertical line as a parent's. Asserted
   * as the title's position in row 1, which is the thing that has to be equal
   * — jsdom lays nothing out, so widths would prove nothing.
   */
  it("reserves the chevron gutter on a childless row (B51.1)", () => {
    const { container: withChildren } = renderRow(row({ childCount: 2 }));
    const parentIndex = titleIndex(rowOne(withChildren));
    cleanup();

    const { container: childless } = renderRow(row({ childCount: 0 }));

    expect(titleIndex(rowOne(childless))).toBe(parentIndex);
    expect(
      rowOne(childless).querySelector('[aria-label*="child threads"]'),
    ).toBeNull();
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

  it("makes one PR hook call and shares it with the chip (B33)", () => {
    const { container } = renderRow(withEnvironment(), {
      sidebarPullRequests: { t1: pr() },
    });

    expect(rowElement(container).textContent).toContain("#42");
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
