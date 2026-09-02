// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import {
  installTestPluginRuntime,
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginSidebarThread,
  PluginSidebarThreadIndicator,
  PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";

installTestPluginRuntime();

const { ChildThreadsChip } = await import("./ChildThreadsChip");
const { resetThreadExecutionsCache } = await import("./useThreadExecutions");
const { resetThreadWorkStatsCache } = await import("./useThreadWorkStats");
const { betterSidebarRpcContract } = await import("../server-contract");

type Contract = typeof betterSidebarRpcContract;

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

beforeEach(() => {
  // The execution caches are module-level and outlive `cleanup()` (B71.4), so
  // a call-count test would otherwise read the previous test's cache.
  resetThreadExecutionsCache();
  resetThreadWorkStatsCache();
});

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
    expect(
      chip().querySelector("[data-better-sidebar-children='count']")?.textContent,
    ).toBe("1");
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

describe("collapsed chip (B58.3, B81)", () => {
  it("shows the count badge and one icon per vendor", () => {
    render([thread("parent"), child("c1", "parent"), child("c2", "parent")]);
    expect(chip().querySelector("[data-better-sidebar-children='count']")?.textContent).toBe("2");
    expect(within(chip()).getAllByRole("img", { name: "claude" })).toHaveLength(
      1,
    );
    expect(
      chip().querySelector("[data-better-sidebar-children='overflow']"),
    ).toBeNull();
  });

  it("dedupes vendor icons across five children and still counts them all", () => {
    render([
      thread("parent"),
      child("c1", "parent"),
      child("c2", "parent"),
      child("c3", "parent"),
      child("c4", "parent"),
      child("c5", "parent"),
    ]);
    expect(within(chip()).getAllByRole("img", { name: "claude" })).toHaveLength(
      1,
    );
    expect(chip().querySelector("[data-better-sidebar-children='count']")?.textContent).toBe("5");
  });

  it("shows one icon per distinct vendor, capped at three", () => {
    render([
      thread("parent"),
      child("c1", "parent", { providerId: "claude" }),
      child("c2", "parent", { providerId: "codex" }),
      child("c3", "parent", { providerId: "gemini" }),
      child("c4", "parent", { providerId: "opencode" }),
    ]);
    expect(within(chip()).getAllByRole("img")).toHaveLength(3);
    expect(chip().querySelector("[data-better-sidebar-children='count']")?.textContent).toBe("4");
  });

  it("turns the count badge amber and keeps the words out when a child is blocked on the user", () => {
    render([
      thread("parent"),
      child("c1", "parent"),
      child("c2", "parent", { hasPendingInteraction: true }),
    ]);
    const badge = chip().querySelector("[data-better-sidebar-children='count']");
    expect(badge?.getAttribute("class")).toContain("text-amber-500");
    expect(chip().textContent).not.toContain("Needs you");
  });

  it("renders the same icons plus count on a compact viewport (B58.4)", () => {
    render([thread("parent"), child("c1", "parent")], {
      isCompactViewport: true,
    });
    expect(within(chip()).getAllByRole("img", { name: "claude" })).toHaveLength(
      1,
    );
    expect(chip().querySelector("[data-better-sidebar-children='count']")?.textContent).toBe("1");
    // The accessible name survives.
    expect(chip().getAttribute("aria-label")).toBe("1 child threads");
  });
});

/**
 * B75. Before this, the chip reacted only to attention: a child that was
 * simply running — the common state during a fan-out — carried no mark at all.
 */
describe("working children (B75)", () => {
  const ringed = () =>
    chip().querySelectorAll("[data-better-sidebar-children='running']");

  /**
   * B75.1. The four kinds are `RUNNING_INDICATORS`, the same set the sidebar
   * row draws sky and the same field `StatusGlyph` reads. Each is checked on
   * its own so a set that lost a member fails here.
   */
  it.each<PluginSidebarThreadIndicator>([
    "runtime",
    "workflow",
    "background-agent",
    "background-command",
  ])("rings a child whose indicator is %s (B75.1)", (indicator) => {
    render([thread("parent"), child("c1", "parent", { indicator })]);
    expect(ringed()).toHaveLength(1);
    expect(ringed()[0].getAttribute("class")).toContain("ring-1");
  });

  it("leaves an idle or planning child unringed (B75.1)", () => {
    render([
      thread("parent"),
      child("c1", "parent"),
      child("c2", "parent", { indicator: "plan-mode" }),
      child("c3", "parent", { indicator: "unread-success" }),
    ]);
    expect(ringed()).toHaveLength(0);
  });

  /** B81: the count badge counts all children; running shows as the ring. */
  it("counts every child in the badge when none is running (B75.2)", () => {
    render([
      thread("parent"),
      child("c1", "parent"),
      child("c2", "parent"),
      child("c3", "parent"),
    ]);
    expect(chip().querySelector("[data-better-sidebar-children='count']")?.textContent).toBe("3");
    expect(ringed()).toHaveLength(0);
  });

  it("rings the vendor whose child is running and counts all children (B75.2)", () => {
    render([
      thread("parent"),
      child("c1", "parent", { indicator: "runtime" }),
      child("c2", "parent", { indicator: "workflow" }),
      child("c3", "parent"),
    ]);
    expect(chip().querySelector("[data-better-sidebar-children='count']")?.textContent).toBe("3");
    expect(ringed()).toHaveLength(1);
  });

  /**
   * B75.4. The label and the hue are attention's, because "needs you" is the
   * one state that costs the user something to miss. The rings still draw —
   * they mark a different child than the pending one does.
   */
  it("ambers the count badge for attention, and still rings (B75.4)", () => {
    render([
      thread("parent"),
      child("c1", "parent", { hasPendingInteraction: true }),
      child("c2", "parent", { indicator: "runtime" }),
    ]);
    expect(
      chip()
        .querySelector("[data-better-sidebar-children='count']")
        ?.getAttribute("class"),
    ).toContain("text-amber-500");
    expect(ringed()).toHaveLength(1);
  });

  /**
   * B75.5. The rings are the only working signal the phone gets, which is the
   * reason the signal is a mark and not just a word.
   */
  it("keeps the rings on a compact viewport, same as everywhere else (B75.5)", () => {
    render(
      [thread("parent"), child("c1", "parent", { indicator: "runtime" })],
      { isCompactViewport: true },
    );
    expect(ringed()).toHaveLength(1);
  });

  /**
   * B75.3/B75.6. A ring is a box-shadow, so it adds no layout size and cannot
   * grow the cluster or shift the chip's 28px box. No motion either: this sits
   * in the header above the thread the user is reading.
   */
  it("adds no motion and no size to the cluster (B75.3, B75.6)", () => {
    render([thread("parent"), child("c1", "parent", { indicator: "runtime" })]);
    const cluster = ringed()[0].parentElement as HTMLElement;
    const className = ringed()[0].getAttribute("class") ?? "";

    expect(className).not.toContain("animate-");
    expect(cluster.getAttribute("class") ?? "").not.toContain("animate-");
    // No padding, margin or size utility rides along with the ring.
    expect(className).not.toMatch(/(^|\s)(p|m|size|h|w)-/);
    // B58.5: the chip is still the 28px control.
    expect(chip().getAttribute("class")).toContain("h-7");
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

  // Amendment 2a supersedes B58.6's origin line: the second line is now
  // model, effort and duration (B70), and it is absent until the batch lands.
  it("lists every child with title and status glyph", () => {
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
    // Row 1's own title resolution, whitespace trim included.
    expect(items[1].textContent).toContain("Fallback");
    // B70.3: the word "thread" is gone from the popover for good.
    expect(items[1].textContent).not.toContain("thread");
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

  it("opens a child in split and closes the popover", () => {
    const rendered = openWith([thread("parent"), child("c1", "parent")]);
    fireEvent.click(within(screen.getByRole("list")).getByRole("button"));
    expect(rendered.inspection.sidebarActionCalls).toContainEqual(
      expect.objectContaining({
        method: "open",
        threadId: "c1",
        options: { split: true },
      }),
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

// ---------------------------------------------------------------------------
// Amendment 2a — B70, B71, B72
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The quantized clock `useNow` serves, so a duration lands on the bucket. */
function nowMinute(): number {
  return Math.floor(Date.now() / MINUTE) * MINUTE;
}

function handlers(
  overrides: Partial<PluginRpcTestHandlers<Contract>> = {},
): PluginRpcTestHandlers<Contract> {
  return {
    threadDossier: () => {
      throw new Error("the chip never calls threadDossier");
    },
    rowSignals: () => ({ signals: [] }),
    threadExecutions: ({ threadIds }) => ({
      executions: threadIds.map((threadId) => ({
        threadId,
        execution: { model: "claude-opus-5", reasoningLevel: "high" },
      })),
    }),
    threadWorkStats: ({ threadIds }) => ({
      stats: threadIds.map((threadId) => ({
        threadId,
        tokens: 85700,
        toolCalls: 11,
      })),
    }),
    lastActivity: () => ({ activity: [] }),
    localHost: () => ({ hostId: null }),
    ...overrides,
  };
}

function renderRich(
  threads: PluginSidebarThread[],
  extra: {
    rpc?: Partial<PluginRpcTestHandlers<Contract>>;
    settings?: Record<string, string>;
  } = {},
) {
  return renderSlot<PluginThreadHeaderActionProps, Contract>(
    { component: ChildThreadsChip },
    { threadId: "parent", projectId: "p1", isCompactViewport: false },
    {
      sidebarThreads: { status: "ready", threads },
      rpc: handlers(extra.rpc),
      ...(extra.settings === undefined ? {} : { settings: extra.settings }),
    },
  );
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function executionCalls(slot: { inspection: { rpcCalls: { method: string }[] } }) {
  return slot.inspection.rpcCalls.filter(
    (call) => call.method === "threadExecutions",
  );
}

function rows() {
  return within(screen.getByRole("list")).getAllByRole("listitem");
}

describe("batched executions call (B71)", () => {
  it("issues no call at all while the chip is closed (B71.2)", async () => {
    const slot = renderRich([thread("parent"), child("c1", "parent")]);
    await settle();
    expect(executionCalls(slot)).toHaveLength(0);
  });

  it("issues exactly one call for seventeen children (B71.1)", async () => {
    const children = Array.from({ length: 17 }, (_, i) =>
      child(`c${i}`, "parent"),
    );
    const slot = renderRich([thread("parent"), ...children]);
    fireEvent.click(chip());
    await settle();

    const calls = executionCalls(slot);
    expect(calls).toHaveLength(1);
    expect(rows()).toHaveLength(17);
  });

  it("re-opening inside the READY TTL issues no second call (B71.4)", async () => {
    const slot = renderRich([
      thread("parent"),
      child("c1", "parent"),
      child("c2", "parent"),
    ]);
    fireEvent.click(chip());
    await settle();
    expect(executionCalls(slot)).toHaveLength(1);

    fireEvent.click(chip());
    await settle();
    fireEvent.click(chip());
    await settle();
    expect(executionCalls(slot)).toHaveLength(1);
    expect(rows()[0].textContent).toContain("claude-opus-5");
  });

  it("keeps every title and the status glyph when the call rejects (B71.3)", async () => {
    const slot = renderRich(
      [
        thread("parent"),
        child("c1", "parent", {
          indicator: "waiting-for-input",
          indicatorLabel: "Thread needs user input",
        }),
        child("c2", "parent", {
          indicator: "waiting-for-input",
          indicatorLabel: "Thread needs user input",
        }),
      ],
      {
        rpc: {
          threadExecutions: () => {
            throw new Error("backend unavailable");
          },
        },
      },
    );
    fireEvent.click(chip());
    await settle();

    // The list is intact — a failed lookup never blanks the children. The
    // provider mark rides on the metadata line (B83), so it is absent too.
    expect(rows()).toHaveLength(2);
    for (const row of rows()) {
      expect(row.textContent).toMatch(/c[12]/);
      expect(
        within(row).getByRole("img", { name: "Thread needs user input" }),
      ).toBeTruthy();
    }
    // B71.3: the metadata line is simply absent, and no spinner replaces it.
    expect(screen.getByRole("list").textContent).not.toContain("·");
    expect(screen.getByRole("list").textContent).not.toContain("claude");
    expect(executionCalls(slot)).toHaveLength(1);
  });

  it("renders no metadata line while the batch is still in flight (B71.3)", () => {
    renderRich([thread("parent"), child("c1", "parent")]);
    fireEvent.click(chip());
    // Before `settle()`: loading. Title and glyph, nothing else.
    expect(rows()[0].textContent).toContain("c1");
    expect(rows()[0].textContent).not.toContain("claude-opus-5");
    expect(rows()[0].textContent).not.toContain("·");
  });
});

describe("child row metadata (B83/B85, sidebar-consistent)", () => {
  it("renders model, effort, duration, tokens and tools on the second line (B85)", async () => {
    const base = nowMinute();
    renderRich(
      [
        thread("parent"),
        child("c1", "parent", {
          createdAt: base - 3 * MINUTE,
          updatedAt: base - MINUTE,
        }),
      ],
      {
        rpc: {
          threadExecutions: ({ threadIds }) => ({
            executions: threadIds.map((threadId) => ({
              threadId,
              execution: {
                model: "anthropic/claude-opus-5[1m]",
                reasoningLevel: "xhigh",
              },
            })),
          }),
          threadWorkStats: ({ threadIds }) => ({
            stats: threadIds.map((threadId) => ({
              threadId,
              tokens: 85_700,
              toolCalls: 11,
            })),
          }),
        },
      },
    );
    fireEvent.click(chip());
    await settle();
    const text = rows()[0].textContent ?? "";
    expect(text).toContain("anthropic/claude-opus-5[1m]");
    expect(text).toContain("xhigh");
    // Duration: 2m of work, created 3m ago, finished 1m ago.
    expect(text).toContain("2m");
    // t3's token compaction, not the raw integer.
    expect(text).toContain("85.7k tok");
    expect(text).toContain("11 tools");
  });

  it("drops a null stat's segment without leaving a doubled separator (B70.4)", async () => {
    renderRich([thread("parent"), child("c1", "parent")], {
      rpc: {
        threadWorkStats: ({ threadIds }) => ({
          stats: threadIds.map((threadId) => ({
            threadId,
            tokens: null,
            toolCalls: null,
          })),
        }),
      },
    });
    fireEvent.click(chip());
    await settle();
    const text = rows()[0].textContent ?? "";
    expect(text).toContain("claude-opus-5 · high");
    expect(text).not.toContain("tok");
    expect(text).not.toContain("tools");
    expect(text).not.toMatch(/· .*· .*·/);
  });

  it("shows the sidebar's relative time in the trailing slot and work duration in the line", async () => {
    const base = nowMinute();
    renderRich([
      thread("parent"),
      child("c1", "parent", {
        indicator: "runtime",
        createdAt: base - 47 * MINUTE,
        updatedAt: base - 40 * MINUTE,
      }),
    ]);
    fireEvent.click(chip());
    await settle();
    // The trailing slot is the sidebar's clock: age since last activity.
    expect(rows()[0].textContent).toContain("40m");
    // The metadata line carries the work duration, t3's label (B85).
    expect(rows()[0].textContent).toContain("47m");
  });

  it("drops the whole metadata line on a null execution (B70.4)", async () => {
    const base = nowMinute();
    renderRich(
      [thread("parent"), child("c1", "parent")],
      {
        rpc: {
          threadExecutions: ({ threadIds }) => ({
            executions: threadIds.map((threadId) => ({
              threadId,
              execution: null,
            })),
          }),
        },
      },
    );
    fireEvent.click(chip());
    await settle();

    // The sidebar's child row drops the line entirely; no mark with nothing
    // to qualify, no placeholder.
    expect(rows()[0].textContent).not.toContain("·");
    expect(rows()[0].textContent).not.toContain("claude-opus-5");
  });
});

describe("settings gate (B72)", () => {
  it("makes no call and shows no metadata at density compact (B72.1)", async () => {
    const slot = renderRich(
      [
        thread("parent"),
        child("c1", "parent", {
          indicator: "waiting-for-input",
          indicatorLabel: "Thread needs user input",
        }),
      ],
      { settings: { density: "compact" } },
    );
    fireEvent.click(chip());
    await settle();

    // B60.1: compact performs no backend RPC of any kind — neither lookup.
    expect(executionCalls(slot)).toHaveLength(0);
    expect(slot.inspection.rpcCalls.filter((c) => c.method === "threadWorkStats")).toHaveLength(0);
    // The row is still a row: title, status, and the trailing time.
    const row = rows()[0];
    expect(row.textContent).toContain("c1");
    expect(
      within(row).getByRole("img", { name: "Thread needs user input" }),
    ).toBeTruthy();
    // The provider mark rides the metadata line (B83); without it, no mark.
    expect(within(row).queryByRole("img", { name: "claude" })).toBeNull();
    expect(row.textContent).not.toContain("claude-opus-5");
  });

  it("makes no call when the chip is hidden entirely (B72.2)", async () => {
    const slot = renderRich([thread("parent"), child("c1", "parent")], {
      settings: { showHeaderChip: "false" },
    });
    await settle();
    expect(slot.container.innerHTML).toBe("");
    expect(executionCalls(slot)).toHaveLength(0);
  });
});

/**
 * A parent with seventeen subagents overflowed the viewport and the card
 * clipped: `overflow-hidden` is what rounds its corners, and nothing beneath
 * it could scroll.
 */
describe("ChildThreadsChip overflow", () => {
  function open(children: PluginSidebarThread[]) {
    render([thread("parent"), ...children]);
    fireEvent.click(chip());
  }

  it("caps the card at the room Radix measured and scrolls the list", () => {
    open(
      Array.from({ length: 40 }, (_, index) =>
        child(`kid_${index}`, "parent", { title: `Child ${index}` }),
      ),
    );

    const card = screen.getByLabelText("Child threads");
    expect(card.style.maxHeight).toBe(
      "var(--radix-popover-content-available-height)",
    );
    expect(card.className).toContain("flex-col");

    const list = card.querySelector("ul")!;
    expect(list.className).toContain("overflow-y-auto");
    // Without `min-h-0` a flex child refuses to shrink below its content, so
    // the list would grow past the cap instead of scrolling inside it.
    expect(list.className).toContain("min-h-0");
    expect(list.children).toHaveLength(40);
  });

  it("keeps the header out of the scroll area", () => {
    open([child("kid_0", "parent")]);

    const card = screen.getByLabelText("Child threads");
    expect(card.firstElementChild!.className).toContain("shrink-0");
    expect(card.firstElementChild!.textContent).toContain("Children");
  });
});
