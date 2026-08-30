// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import {
  installTestPluginRuntime,
  loadPluginApp,
  renderSlot,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginSidebarThread,
  PluginSidebarThreadIndicator,
  PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";

installTestPluginRuntime();

const { ChildThreadsChip } = await import("./ChildThreadsChip");

const NOW = 1_700_000_000_000;

function thread(
  id: string,
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id,
    projectId: "p1",
    title: id,
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "claude",
    hasPendingInteraction: false,
    activity: {} as PluginSidebarThread["activity"],
    indicator: "none" as PluginSidebarThreadIndicator,
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastReadAt: null,
    latestAttentionAt: NOW,
    ...overrides,
  };
}

function child(
  id: string,
  parent: string,
  overrides: Partial<PluginSidebarThread> = {},
) {
  return thread(id, { parentThreadId: parent, ...overrides });
}

function render(
  threads: PluginSidebarThread[],
  props: Partial<PluginThreadHeaderActionProps> = {},
  options: RenderSlotOptions = {},
) {
  return renderSlot(
    { component: ChildThreadsChip },
    {
      threadId: "parent",
      projectId: "p1",
      isCompactViewport: false,
      ...props,
    },
    { sidebarThreads: { status: "ready", threads }, ...options },
  );
}

/** The chip's trigger, by the accessible name B58.3 gives it. */
function chip() {
  return screen.getByRole("button", { name: /child threads$/ });
}

afterEach(() => {
  cleanup();
});

describe("registration (B58.1)", () => {
  it("registers the chip as a thread header action", async () => {
    const app = await loadPluginApp(() => import("../../app"));
    expect(app.threadHeaderActions).toHaveLength(1);
    expect(app.threadHeaderActions[0]).toMatchObject({
      id: "children",
      title: "Child threads",
      component: ChildThreadsChip,
    });
  });
});

describe("showHeaderChip (B59)", () => {
  it("renders nothing when the setting is off, children present", () => {
    const { container } = render(
      [thread("parent"), child("c1", "parent")],
      {},
      { settings: { showHeaderChip: "false" } },
    );
    expect(container.innerHTML).toBe("");
  });

  it("renders the chip when the setting is on", () => {
    render(
      [thread("parent"), child("c1", "parent")],
      {},
      { settings: { showHeaderChip: "true" } },
    );
    expect(chip().textContent).toContain("1 children");
  });
});

describe("empty case (B58.2)", () => {
  it("renders nothing at all when the thread has no children", () => {
    const { container } = render([thread("parent"), thread("stranger")]);
    expect(container.innerHTML).toBe("");
  });

  it("ignores another thread's children", () => {
    const { container } = render([
      thread("parent"),
      thread("other"),
      child("c1", "other"),
    ]);
    expect(container.innerHTML).toBe("");
  });
});

describe("collapsed chip (B58.3, B58.4)", () => {
  it("shows a count label and one glyph per child up to three", () => {
    render([thread("parent"), child("c1", "parent"), child("c2", "parent")]);
    expect(chip().textContent).toContain("2 children");
    expect(within(chip()).getAllByRole("img", { name: "claude" })).toHaveLength(
      2,
    );
    expect(
      chip().querySelector("[data-better-sidebar-children='overflow']"),
    ).toBeNull();
  });

  it("caps the cluster at three glyphs and adds an overflow marker", () => {
    render([
      thread("parent"),
      child("c1", "parent"),
      child("c2", "parent"),
      child("c3", "parent"),
      child("c4", "parent"),
      child("c5", "parent"),
    ]);
    expect(within(chip()).getAllByRole("img", { name: "claude" })).toHaveLength(
      3,
    );
    expect(
      chip().querySelector("[data-better-sidebar-children='overflow']")
        ?.textContent,
    ).toBe("+2");
    expect(chip().textContent).toContain("5 children");
  });

  it("reads 'Needs you' when any child is blocked on the user", () => {
    render([
      thread("parent"),
      child("c1", "parent"),
      child("c2", "parent", { hasPendingInteraction: true }),
    ]);
    expect(chip().textContent).toContain("Needs you");
    expect(chip().textContent).not.toContain("2 children");
  });

  it("drops the label on a compact viewport but keeps the cluster (B58.4)", () => {
    render([thread("parent"), child("c1", "parent")], {
      isCompactViewport: true,
    });
    expect(chip().textContent).not.toContain("1 children");
    expect(within(chip()).getAllByRole("img", { name: "claude" })).toHaveLength(
      1,
    );
    // The accessible name survives the dropped label.
    expect(chip().getAttribute("aria-label")).toBe("1 child threads");
  });
});

describe("header chrome fit (B58.5)", () => {
  it("is a 28px shrink-0 inline control", () => {
    render([thread("parent"), child("c1", "parent")]);
    expect(chip().className).toContain("h-7");
    expect(chip().className).toContain("shrink-0");
  });
});

describe("open popover (B58.6, B58.7, B58.8)", () => {
  function openWith(threads: PluginSidebarThread[]) {
    const rendered = render(threads);
    fireEvent.click(chip());
    return rendered;
  }

  it("lists every child with title, origin and status glyph", () => {
    openWith([
      thread("parent"),
      child("c1", "parent", {
        originKind: "fork",
        indicator: "waiting-for-input",
        indicatorLabel: "Thread needs user input",
      }),
      child("c2", "parent", { title: null, titleFallback: "  Fallback  " }),
    ]);
    const list = screen.getByRole("list");
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("c1");
    expect(items[0].textContent).toContain("fork");
    // Row 1's own title resolution, whitespace trim included.
    expect(items[1].textContent).toContain("Fallback");
    // A child with no originKind reads as a plain thread, not as blank.
    expect(items[1].textContent).toContain("thread");
    // B58.7: this plugin's StatusGlyph, labelled by the host's own string.
    expect(
      within(items[0]).getByRole("img", { name: "Thread needs user input" }),
    ).toBeTruthy();
  });

  it("uses this plugin's ProviderGlyph, resolved through the directory (B58.7)", () => {
    render([thread("parent"), child("c1", "parent")], undefined, {
      providers: {
        status: "ready",
        providers: [
          { id: "claude", displayName: "Claude Code", logoUrl: null } as never,
        ],
      },
    });
    // The directory's displayName, and the plugin's neutral-dot fallback for a
    // provider with no logo — the same three-case glyph the sidebar row draws.
    const glyphs = screen.getAllByRole("img", { name: "Claude Code" });
    expect(glyphs.length).toBeGreaterThan(0);
    expect(
      glyphs[0].querySelector("[data-better-sidebar-provider='dot']"),
    ).toBeTruthy();
  });

  it("opens a child and closes the popover", () => {
    const rendered = openWith([thread("parent"), child("c1", "parent")]);
    fireEvent.click(within(screen.getByRole("list")).getByRole("button"));
    expect(rendered.inspection.sidebarActionCalls).toContainEqual(
      expect.objectContaining({ method: "open", threadId: "c1" }),
    );
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("portals the panel out of the chip and scopes it back to the plugin (B58.8)", () => {
    const { container } = openWith([thread("parent"), child("c1", "parent")]);
    const panel = screen.getByRole("dialog", { name: "Child threads" });
    // Portalled: it is not inside the slot's own container.
    expect(container.contains(panel)).toBe(false);
    // Portal-scoped through the same seam every overlay in this plugin uses.
    expect(panel.getAttribute("data-bb-portaled-overlay")).toBe("");
    expect(panel.getAttribute("data-bb-plugin-root")).toBe("");
  });

  it("starts closed", () => {
    render([thread("parent"), child("c1", "parent")]);
    expect(chip().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list")).toBeNull();
  });
});

describe("per-pane open state (B58.9)", () => {
  it("opening one pane's chip leaves the other pane's chip closed", () => {
    function TwoPanes() {
      return (
        <>
          <ChildThreadsChip
            threadId="parent"
            projectId="p1"
            isCompactViewport={false}
          />
          <ChildThreadsChip
            threadId="other"
            projectId="p1"
            isCompactViewport={false}
          />
        </>
      );
    }
    renderSlot(
      { component: TwoPanes },
      {},
      {
        sidebarThreads: {
          status: "ready",
          threads: [
            thread("parent"),
            thread("other"),
            child("c1", "parent"),
            child("c2", "other"),
            child("c3", "other"),
          ],
        },
      },
    );

    const [first, second] = screen.getAllByRole("button", {
      name: /child threads$/,
    });
    expect(first.getAttribute("aria-label")).toBe("1 child threads");
    expect(second.getAttribute("aria-label")).toBe("2 child threads");

    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("true");
    // Module-level open state would have opened this one too.
    expect(second.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByRole("list")).toHaveLength(1);
    expect(
      within(screen.getByRole("list")).getAllByRole("listitem"),
    ).toHaveLength(1);
  });
});

describe("unexpected data (B58.10)", () => {
  beforeEach(() => {
    // React logs the caught error; the test asserts the chip survived it.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats a non-array thread list as no children", () => {
    const { container } = render(undefined as unknown as PluginSidebarThread[]);
    expect(container.innerHTML).toBe("");
  });

  it("skips malformed entries rather than throwing on them", () => {
    const { container } = render([
      thread("parent"),
      null as unknown as PluginSidebarThread,
      { parentThreadId: "parent" } as unknown as PluginSidebarThread,
    ]);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing rather than propagating a throw out of the chip", () => {
    const exploding = new Proxy(thread("parent"), {
      get(target, key) {
        if (key === "parentThreadId") throw new Error("boom");
        return Reflect.get(target, key);
      },
    }) as PluginSidebarThread;
    const { container } = render([exploding]);
    expect(container.innerHTML).toBe("");
  });
});
