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

  /** B57.3: no base left inset; only B9's per-depth nesting indent survives. */
  it("starts the provider glyph at the row's left edge (B57.3)", () => {
    const { container: root } = renderRow(row({ depth: 0 }));
    const rootBox = rowElement(root).firstElementChild as HTMLElement;
    expect(rootBox.style.paddingLeft).toBe("0px");
    cleanup();

    const { container: child } = renderRow(row({ depth: 2 }));
    const childBox = rowElement(child).firstElementChild as HTMLElement;
    expect(childBox.style.paddingLeft).toBe("24px");
  });

  /**
   * B57.4. `RowSignals` stays mounted at zero width because it owns the
   * IntersectionObserver ref, and under the old per-element margins it changed
   * what the trailing cluster measured. The gap between the status glyph and
   * the time must not depend on which siblings happen to draw.
   */
  it("keeps status-to-time spacing identical whatever else draws (B57.4)", () => {
    const withStatus = renderRow(
      row({ thread: thread({ indicator: "waiting-for-input" }) }),
    );
    const cluster = rowOne(withStatus.container).lastElementChild!;
    const [signals, status, time] = Array.from(cluster.children);

    // The signals span carries no margin of its own, so a mounted zero-width
    // element contributes no gap; every element that draws carries the same one.
    expect(signals.getAttribute("class")).not.toContain("ml-");
    expect(status.getAttribute("class")).toContain("ml-1.5");
    expect(time.getAttribute("class")).toContain("ml-1.5");
    cleanup();

    const { container } = renderRow(row({ thread: thread({ indicator: "none" }) }));
    const bare = rowOne(container).lastElementChild!;
    expect(bare.lastElementChild!.getAttribute("class")).toContain("ml-1.5");
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
 *
 * jsdom lays nothing out, so these assert the flex contract that decides the
 * outcome rather than measured pixels: who may shrink, and what caps whom.
 * The rendered check at panel width is B56.5's manual step.
 */
describe("ThreadRow row 2 under pressure (B56)", () => {
  const LONG_BRANCH = "bb/create-customizable-plugin-version-with-a-very-long-slug";

  function rowTwoLabels(container: HTMLElement) {
    const one = rowOne(container);
    const two = one.nextElementSibling!.firstElementChild!;
    return {
      project: two.firstElementChild!,
      branch: two.children[1]!,
    };
  }

  /**
   * B56.1/B56.2, the first polarity: a ten-character project name survives a
   * branch four times its length. `shrink-0` takes the project out of the
   * proportional shrink; the branch is the only shrinkable child left, so it
   * absorbs the whole deficit.
   */
  it("leaves a 10-character project intact beside a long branch (B56.1, B56.2)", () => {
    const { container } = renderRow(
      row({ projectName: "bb-plugins", workspaceLabel: LONG_BRANCH }),
    );
    const { project, branch } = rowTwoLabels(container);

    expect(project.textContent).toBe("bb-plugins");
    expect(project.getAttribute("class")).toContain("shrink-0");
    expect(branch.getAttribute("class")).toContain("shrink");
    expect(branch.getAttribute("class")).toContain("min-w-0");
    expect(branch.querySelector(".truncate")!.textContent).toBe(LONG_BRANCH);
  });

  /**
   * B56.2, the other polarity: the project is not exempt from truncation, it
   * is capped. A name that alone exceeds ~45% of row 2 still truncates —
   * expressed as a percentage of the line, so no pixel is guessed.
   */
  it("still truncates a project name over its own cap (B56.2)", () => {
    const { container } = renderRow(
      row({
        projectName: "a-project-name-far-longer-than-half-this-row",
        workspaceLabel: "main",
      }),
    );
    const { project } = rowTwoLabels(container);

    expect(project.getAttribute("class")).toContain("max-w-[45%]");
    expect(project.getAttribute("class")).toContain("truncate");
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
   * Only the mark is hidden, never its box: with the setting off, row 1's
   * first child still measures `size-3.5`, so the title and row 2 keep the x
   * they have with the setting on.
   */
  it("keeps the provider column reserved when showProviderGlyph is off", () => {
    const { container } = renderRow(row(), {}, { showProviderGlyph: false });

    expect(rowOne(container).firstElementChild!.className).toContain("size-3.5");
  });

  it("draws no relative time when showRelativeTime is off", () => {
    const { container } = renderRow(row(), {}, { showRelativeTime: false });
    expect(rowOne(container).lastElementChild!.textContent).not.toContain("1d");
  });
});
