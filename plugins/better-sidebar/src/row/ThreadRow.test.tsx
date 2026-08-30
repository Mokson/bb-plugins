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

function rowElement(container: HTMLElement): HTMLElement {
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
  it("carries both shortcut attributes on the interactive element (B44)", () => {
    const { container } = renderRow(row());
    const element = rowElement(container);

    expect(element.getAttribute("data-sidebar-thread-shortcut-target")).toBe("");
    expect(element.getAttribute("data-sidebar-thread-id")).toBe("t1");
    expect(element.getAttribute("role")).toBe("button");
  });

  it("spreads splitProps onto that same element (B45)", () => {
    const { container } = renderRow(row());
    fireEvent.pointerDown(rowElement(container));
    expect(splitPointerDown).toHaveBeenCalledTimes(1);
  });

  it("opens the thread and calls onNavigate (B47)", () => {
    const { container, inspection } = renderRow(row());
    fireEvent.click(rowElement(container));

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
  });
});

describe("ThreadRow chrome", () => {
  it("carries isUnread as font weight and never as opacity (B14)", () => {
    const { container } = renderRow(row({ thread: thread({ isUnread: true }) }));
    const element = rowElement(container);

    expect(element.textContent).toContain("Ship the sidebar");
    expect(element.querySelector(".font-semibold")).not.toBeNull();
    expect(element.querySelectorAll('[class*="opacity-"]')).toHaveLength(0);
    expect(element.getAttribute("class")).not.toContain("opacity-");
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

    fireEvent.click(screen.getByRole("link"));

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

    fireEvent.click(screen.getByRole("link"));
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

    fireEvent.click(screen.getByRole("link"));
    expect(toastError).not.toHaveBeenCalled();
  });
});
