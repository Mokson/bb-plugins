// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import {
  installTestPluginRuntime,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { RenderRow } from "../model/types";

installTestPluginRuntime();

const { Dossier } = await import("./Dossier");
const { useDossier, resetDossierCache } = await import("./useDossier");
const { resetRowSignals } = await import("./useRowSignals");
const { RowSignals } = await import("./RowSignals");
const { betterSidebarRpcContract } = await import("../server-contract");

type Contract = typeof betterSidebarRpcContract;
type DossierPayload = Awaited<
  ReturnType<PluginRpcTestHandlers<Contract>["threadDossier"]>
>;

const THREAD_ID = "t1";

/** B30's tripwire: any figure that reads as money, in any of bb's currencies. */
const CURRENCY = /(?:[$€£¥]\s?\d)|(?:\d\s?(?:USD|EUR|GBP|cents?|dollars?))/i;

function full(): DossierPayload {
  return {
    threadId: THREAD_ID,
    execution: { model: "claude-opus-5", reasoningLevel: "high" },
    economics: {
      total: {
        totalTokens: 1234,
        inputTokens: 1000,
        cachedInputTokens: 900,
        outputTokens: 200,
        reasoningOutputTokens: 34,
      },
      modelContextWindow: 200_000,
    },
    contextWindow: {
      usedTokens: 50_000,
      modelContextWindow: 200_000,
      estimated: false,
    },
    fetchedAt: 0,
  };
}

function thread(overrides: Partial<PluginSidebarThread> = {}): PluginSidebarThread {
  return {
    id: THREAD_ID,
    projectId: "proj_1",
    title: "Rework the sidebar",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
    hasPendingInteraction: false,
    activity: {
      workflows: 2,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 1,
    },
    indicator: "waiting-for-input",
    indicatorLabel: "Thread is working",
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: Date.UTC(2026, 0, 1, 9, 30, 0),
    updatedAt: Date.UTC(2026, 0, 1, 10, 15, 0),
    lastReadAt: null,
    latestAttentionAt: 0,
    ...overrides,
  };
}

/** The row the list already built; the dossier reads its identity from here. */
function row(overrides: Partial<RenderRow> = {}): RenderRow {
  return {
    thread: thread(),
    title: "Rework the sidebar",
    workspaceLabel: "feat/a-very-long-branch-name-row-two-truncates",
    depth: 0,
    childCount: 0,
    projectName: "bb",
    dimLevel: 0,
    sectionKey: "today",
    ...overrides,
  };
}

function Harness({
  variant,
  threadOverrides,
  rowOverrides,
}: {
  variant?: "rich" | "minimal";
  threadOverrides?: Partial<PluginSidebarThread>;
  rowOverrides?: Partial<RenderRow>;
}) {
  const state = useDossier(THREAD_ID, variant !== "minimal");
  return (
    <Dossier
      row={row({ thread: thread(threadOverrides), ...rowOverrides })}
      state={state}
      variant={variant}
    />
  );
}

function render(
  rpc: Partial<PluginRpcTestHandlers<Contract>> = {},
  props: {
    variant?: "rich" | "minimal";
    threadOverrides?: Partial<PluginSidebarThread>;
    rowOverrides?: Partial<RenderRow>;
  } = {},
) {
  return renderSlot<
    {
      variant?: "rich" | "minimal";
      threadOverrides?: Partial<PluginSidebarThread>;
      rowOverrides?: Partial<RenderRow>;
    },
    Contract
  >({ component: Harness }, props, {
    rpc: {
      threadDossier: () => full(),
      rowSignals: () => ({ signals: [] }),
      threadExecutions: () => ({ executions: [] }),
      lastActivity: () => ({ activity: [] }),
      localHost: () => ({ hostId: null }),
      ...rpc,
    },
    sidebarThreads: {
      status: "ready",
      threads: [thread()],
      projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
    },
  });
}

/** B38's dossier section reads the same signal cache the row cluster fills. */
function SignalsHarness() {
  const state = useDossier(THREAD_ID, true);
  return (
    <>
      <RowSignals threadId={THREAD_ID} />
      <Dossier row={row()} state={state} />
    </>
  );
}

function renderWithSignals(rpc: Partial<PluginRpcTestHandlers<Contract>> = {}) {
  installIntersectingObserver();
  return renderSlot<Record<string, never>, Contract>(
    { component: SignalsHarness },
    {},
    {
      rpc: {
        threadDossier: () => full(),
        rowSignals: () => ({ signals: [] }),
      threadExecutions: () => ({ executions: [] }),
      lastActivity: () => ({ activity: [] }),
      localHost: () => ({ hostId: null }),
        ...rpc,
      },
      sidebarThreads: {
        status: "ready",
        threads: [thread()],
        projects: [{ id: "proj_1", name: "bb", isPersonal: false }],
      },
    },
  );
}

/** jsdom ships no IntersectionObserver; this one reports everything visible. */
function installIntersectingObserver() {
  class Stub implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "";
    readonly thresholds: readonly number[] = [];
    readonly scrollMargin = "";
    constructor(private readonly callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ target, isIntersecting: true } as IntersectionObserverEntry],
        this,
      );
    }
    unobserve() {}
    disconnect() {}
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", Stub);
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T12:00:00Z"));
  resetDossierCache();
  resetRowSignals();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Dossier contents (B29)", () => {
  it("renders every field that is present", async () => {
    render();
    await settle();

    expect(screen.getByText("Rework the sidebar")).not.toBeNull();
    expect(screen.getByText("Thread is working")).not.toBeNull();
    // Only non-zero activity counts.
    expect(document.querySelector('[data-dossier-activity="workflows"]')).not.toBeNull();
    expect(document.querySelector('[data-dossier-activity="goals"]')).not.toBeNull();
    expect(
      document.querySelector('[data-dossier-activity="backgroundAgents"]'),
    ).toBeNull();

    expect(screen.getByText("claude-opus-5 · high")).not.toBeNull();
    // Local short form, TZ pinned to UTC by the vitest config. No seconds,
    // no zone suffix, and no year while the timestamp is from this one.
    expect(screen.getByText("Jan 1, 09:30")).not.toBeNull();
    expect(screen.getByText("Jan 1, 10:15")).not.toBeNull();
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("25");
    // Billed total, then the input side (1,000 uncached + 900 cache-read)
    // paired with output on one row.
    expect(screen.getByText("1,234")).not.toBeNull();
    expect(screen.getByText("1,900 / 200")).not.toBeNull();
  });

  it("omits model and effort together when execution options never resolved (§7 B29)", async () => {
    render({ threadDossier: () => ({ ...full(), execution: null }) });
    await settle();

    expect(screen.queryByText(/claude-opus-5/)).toBeNull();
    expect(screen.queryByText("Model")).toBeNull();
    // The rest of the dossier still renders.
    expect(screen.getByText("Rework the sidebar")).not.toBeNull();
    expect(screen.getByText("1,234")).not.toBeNull();
  });
});

describe("Dossier identity line", () => {
  /**
   * `indicatorLabel` is null exactly when the indicator is "none", and the
   * fallback printed the raw key — so every idle thread carried the word
   * "none" under its title.
   */
  it("draws nothing for an idle thread instead of the word none", async () => {
    render({}, { threadOverrides: { indicator: "none", indicatorLabel: null } });
    await settle();

    expect(screen.queryByText("none")).toBeNull();
    expect(document.querySelector("[data-dossier-indicator]")).toBeNull();
    // The rest of the identity block still renders.
    expect(screen.getByText("Rework the sidebar")).not.toBeNull();
  });

  it("still names a non-idle indicator", async () => {
    render();
    await settle();

    expect(screen.getByText("Thread is working")).not.toBeNull();
  });
});

describe("Dossier economics (B30, B31)", () => {
  it("omits the economics section entirely for a null payload, with no zeros or dashes", async () => {
    const slot = render({
      threadDossier: () => ({ ...full(), economics: null, contextWindow: null }),
    });
    await settle();

    const text = slot.container.textContent ?? "";
    expect(screen.queryByText("Tokens")).toBeNull();
    expect(screen.queryByText("Billed total")).toBeNull();
    expect(text).not.toMatch(/\b0\b/);
    expect(text).not.toContain("—");
    expect(screen.queryByRole("meter")).toBeNull();

    // …and the rest of the dossier still renders. This is `status: "ready"`,
    // not the error branch — the two can never be conflated.
    expect(screen.getByText("Rework the sidebar")).not.toBeNull();
    expect(screen.getByText("claude-opus-5 · high")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders no monetary figure anywhere, in either payload shape", async () => {
    const slot = render();
    await settle();
    expect(slot.container.textContent ?? "").not.toMatch(CURRENCY);

    cleanup();
    resetDossierCache();
    const nulled = render({
      threadDossier: () => ({ ...full(), economics: null }),
    });
    await settle();
    expect(nulled.container.textContent ?? "").not.toMatch(CURRENCY);
  });
});

describe("Dossier layout and labels", () => {
  it("puts branch and model under a heading, like every other field", async () => {
    render();
    await settle();

    // One field style: no row sits loose above the first section.
    expect(screen.getByText("Thread")).not.toBeNull();
    expect(screen.getByText("Branch")).not.toBeNull();
    expect(screen.getByText("Model")).not.toBeNull();
  });

  it("omits the thread section when it has neither branch nor model", async () => {
    render(
      { threadDossier: () => ({ ...full(), execution: null }) },
      { rowOverrides: { workspaceLabel: null } },
    );
    await settle();

    expect(screen.queryByText("Thread")).toBeNull();
  });

  /** Seconds and a UTC suffix were noise; the reader's own zone is not. */
  it("drops seconds and the zone suffix from timestamps", async () => {
    render();
    await settle();

    expect(screen.queryByText(/UTC/)).toBeNull();
    expect(screen.queryByText(/09:30:00/)).toBeNull();
  });

  /**
   * A branch is the one field that must be shown in full, so it wraps rather
   * than truncates. Left-aligned, its second line started at a different x
   * from its first and broke the right edge every other row shares.
   */
  it("keeps a wrapped value on the right edge the other rows share", async () => {
    render({}, {
      rowOverrides: {
        workspaceLabel: "bb/remove-docs-and-create-pr-thr_avve33g26y",
      },
    });
    await settle();

    const value = screen.getByText(
      "bb/remove-docs-and-create-pr-thr_avve33g26y",
    );
    expect(value.className).toContain("text-right");
    // An unbroken token wraps instead of overflowing the card.
    expect(value.className).toContain("break-words");
    expect(value.className).toContain("min-w-0");

    // The label never compresses, so the two columns stay put.
    const label = value.previousElementSibling!;
    expect(label.textContent).toBe("Branch");
    expect(label.className).toContain("shrink-0");
  });

  it("leads the context meter with the percentage it means", async () => {
    render();
    await settle();

    expect(screen.getByText("25.0%")).not.toBeNull();
    expect(screen.getByText(/50\.0K \/ 200\.0K/)).not.toBeNull();
  });

  /** "(ESTIMATED)" in the heading made the qualifier the loudest thing here. */
  it("keeps 'estimated' out of the section heading", async () => {
    render({
      threadDossier: () => ({
        ...full(),
        contextWindow: { usedTokens: 50_000, modelContextWindow: 200_000, estimated: true },
      }),
    });
    await settle();

    expect(screen.getByText("Context window")).not.toBeNull();
    // It rides on the label of the row it qualifies, not the section heading.
    expect(screen.getByText("Used (est.)")).not.toBeNull();
  });

  it("abbreviates large counts and keeps small ones exact", async () => {
    render({
      threadDossier: () => ({
        ...full(),
        economics: {
          total: {
            totalTokens: 30_695_321,
            inputTokens: 404,
            cachedInputTokens: 30_598_171,
            outputTokens: 96_746,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 200_000,
        },
      }),
    });
    await settle();

    // Billed total, then input / output on one row. Input is the WHOLE input
    // side — 404 uncached plus 30,598,171 cache-read — not the 404 alone.
    expect(screen.getByText("30.7M")).not.toBeNull();
    expect(screen.getByText("30.6M / 96.7K")).not.toBeNull();
  });

  /**
   * The uncached figure alone is not the input. bb reports uncached and
   * cache-read separately because they bill differently, and on a thread that
   * caches well the uncached one is a rounding error against the input side.
   */
  it("counts cache reads as input rather than printing the uncached figure", async () => {
    render({
      threadDossier: () => ({
        ...full(),
        economics: {
          total: {
            totalTokens: 173_119_358,
            inputTokens: 644,
            cachedInputTokens: 172_935_530,
            outputTokens: 183_184,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 1_000_000,
        },
      }),
    });
    await settle();

    expect(screen.getByText("172.9M / 183.2K")).not.toBeNull();
    // The uncached count is never shown as the input on its own.
    expect(screen.queryByText("644")).toBeNull();
  });

  /** Under 10,000 the exact figure is kept; rounding would lose precision. */
  it("keeps a small count exact", async () => {
    render({
      threadDossier: () => ({
        ...full(),
        economics: {
          total: {
            totalTokens: 1_508,
            inputTokens: 404,
            cachedInputTokens: 0,
            outputTokens: 1_104,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 200_000,
        },
      }),
    });
    await settle();

    expect(screen.getByText("404 / 1,104")).not.toBeNull();
  });

  /**
   * The magnitude is chosen from the ROUNDED figure. Tested against the raw
   * value it printed `1000.0K` — three digits wide and a magnitude behind.
   */
  it("promotes a count that rounds up to the next magnitude", async () => {
    render({
      threadDossier: () => ({
        ...full(),
        economics: {
          total: {
            totalTokens: 999_999,
            inputTokens: 500,
            cachedInputTokens: 500,
            outputTokens: 998_999,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 200_000,
        },
      }),
    });
    await settle();

    expect(screen.getByText("1.0M")).not.toBeNull();
    expect(screen.queryByText("1000.0K")).toBeNull();
    expect(screen.queryByText(/1000\.0K/)).toBeNull();
  });

  it("omits a zero reasoning row and keeps a non-zero one", async () => {
    render({
      threadDossier: () => ({
        ...full(),
        economics: {
          total: {
            totalTokens: 1_234,
            inputTokens: 1_000,
            cachedInputTokens: 900,
            outputTokens: 200,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 200_000,
        },
      }),
    });
    await settle();
    expect(screen.queryByText("Reasoning")).toBeNull();

    cleanup();
    // The payload cache is module state with a 10s TTL, so a second render
    // would otherwise replay the first one's zero.
    resetDossierCache();

    render();
    await settle();
    expect(screen.getByText("Reasoning")).not.toBeNull();
  });
});

describe("Dossier cache hit", () => {
  const tokens = (
    inputTokens: number,
    cachedInputTokens: number,
  ): DossierPayload => ({
    ...full(),
    economics: {
      total: {
        totalTokens: inputTokens + cachedInputTokens,
        inputTokens,
        cachedInputTokens,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      },
      modelContextWindow: 200_000,
    },
  });

  /**
   * The ratio is over the input side only. `inputTokens` excludes cache reads,
   * so `input + cachedInput` is the whole input — dividing by `totalTokens`
   * would let output dilute a figure that has nothing to do with it.
   */
  it("reports the share of input served from cache", async () => {
    render({ threadDossier: () => tokens(1_000, 9_000) });
    await settle();

    expect(screen.getByText("90.0%")).not.toBeNull();
  });

  /**
   * 170,088,977 cached against 888 uncached is 99.99948%, which ROUNDS to a
   * flat 100% — a figure that claims every token came from cache. The share
   * is floored, so only the case that earns 100% reads it.
   */
  it("floors, so an almost-fully-cached thread never reads 100%", async () => {
    render({ threadDossier: () => tokens(888, 170_088_977) });
    await settle();

    expect(screen.getByText("99.9%")).not.toBeNull();
  });

  it("reads 100.0% only when no input was uncached", async () => {
    render({ threadDossier: () => tokens(0, 10_000) });
    await settle();

    expect(screen.getByText("100.0%")).not.toBeNull();
  });

  it("reads 0.0% when nothing was cached, which is a real measurement", async () => {
    render({ threadDossier: () => tokens(1_000, 0) });
    await settle();

    expect(screen.getByText("0.0%")).not.toBeNull();
  });

  /** B31: no input read at all is no data, so the row is omitted entirely. */
  it("omits the row when the thread has read no input", async () => {
    render({ threadDossier: () => tokens(0, 0) });
    await settle();

    expect(screen.queryByText("Cache hit")).toBeNull();
    // The rest of the section still renders.
    expect(screen.getByText("Billed total")).not.toBeNull();
  });

  it("omits it with the whole section on a null economics payload", async () => {
    render({ threadDossier: () => ({ ...full(), economics: null }) });
    await settle();

    expect(screen.queryByText("Cache hit")).toBeNull();
  });
});

describe("Dossier error branch (ruling 10)", () => {
  it("renders one inline error line and a retry, and no spinner", async () => {
    render({
      threadDossier: () => {
        throw new Error("backend unavailable");
      },
    });
    await settle();

    expect(screen.getByRole("alert").textContent).toBe("backend unavailable");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Retry")).not.toBeNull();
    expect(screen.queryByTestId("dossier-skeleton")).toBeNull();
  });
});

describe("Row signals refresh (B37-B40)", () => {
  /**
   * `runBatch` was reachable only from an IntersectionObserver callback or the
   * invalidation channel, so a viewport nobody scrolled and a thread nobody
   * touched had no path back to it at all: every glyph aged past the 30s TTL
   * and never returned.
   */
  it("refreshes a stationary viewport's signals once the TTL lapses", async () => {
    const slot = renderWithSignals();
    await settle();
    const calls = () =>
      slot.inspection.rpcCalls.filter((c) => c.method === "rowSignals").length;
    expect(calls()).toBe(1);

    // Nothing scrolls, nothing publishes. Only the clock moves.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(46_000);
    });
    await settle();
    expect(calls()).toBe(2);
  });
});

describe("Dossier model fallback (B38)", () => {
  it("names originalModel, fallbackModel and the reason", async () => {
    renderWithSignals({
      rowSignals: ({ threadIds }) => ({
        signals: threadIds.map((threadId) => ({
          threadId,
          contextPressure: null,
          modelFallback: {
            originalModel: "claude-opus-5",
            fallbackModel: "claude-sonnet-5",
            reason: "capacity",
            message: "Falling back",
          },
          isRateLimitPaused: false,
          goal: null,
        })),
      }),
    });
    await settle();

    expect(screen.getByText("Model fallback")).not.toBeNull();
    expect(screen.getByText("claude-sonnet-5")).not.toBeNull();
    expect(screen.getByText("capacity")).not.toBeNull();
    // `originalModel` is also the execution model here, so pin both cells.
    expect(document.body.textContent).toContain("claude-opus-5");
  });
});
