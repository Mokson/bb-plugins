// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type {
  PluginSidebarThread,
  PluginSidebarThreadIndicator,
} from "@get-bb/plugin-sdk/app";
import { StatusGlyph } from "./StatusGlyph";

afterEach(cleanup);

/** `StatusGlyph` imports only types from the SDK, so it needs no host. */
function thread(
  indicator: PluginSidebarThreadIndicator,
  indicatorLabel: string | null,
): PluginSidebarThread {
  return {
    id: "t1",
    projectId: "p1",
    title: "Row",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "claude-code",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator,
    indicatorLabel,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: 0,
    updatedAt: 0,
    lastReadAt: null,
    latestAttentionAt: 0,
  };
}

/** B66's palette, as the amendment's table states it. */
const PALETTE: Array<[PluginSidebarThreadIndicator, string, string]> = [
  ["waiting-for-input", "text-indigo-600", "dark:text-indigo-300"],
  ["unread-error", "text-red-700", "dark:text-red-300"],
  ["runtime", "text-sky-600", "dark:text-sky-400"],
  ["workflow", "text-sky-600", "dark:text-sky-400"],
  ["background-agent", "text-sky-600", "dark:text-sky-400"],
  ["background-command", "text-sky-600", "dark:text-sky-400"],
  ["plan-mode", "text-violet-600", "dark:text-violet-400"],
  ["goal", "text-violet-600", "dark:text-violet-400"],
  ["draft", "text-amber-700", "dark:text-amber-300"],
  ["working-draft", "text-amber-700", "dark:text-amber-300"],
  ["unread-success", "text-emerald-700", "dark:text-emerald-300"],
];

describe("StatusGlyph", () => {
  it("labels the glyph with the host's own indicatorLabel (B21)", () => {
    render(<StatusGlyph thread={thread("waiting-for-input", "Thread needs user input")} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      "Thread needs user input",
    );
  });

  it.each(PALETTE)(
    "colours %s with a light/dark pair (B66, B66.1)",
    (indicator, light, dark) => {
      render(<StatusGlyph thread={thread(indicator, "Label")} />);
      const className = screen.getByRole("img").getAttribute("class") ?? "";
      expect(className).toContain(light);
      expect(className).toContain(dark);
    },
  );

  /**
   * B66.4. The spinner used `animate-pulse`, so it faded instead of turning —
   * a spinner that does not spin reads as a rendering bug. Both halves are
   * asserted, because passing by adding a class would miss the point.
   */
  it("spins the runtime spinner rather than pulsing it (B66.4)", () => {
    render(<StatusGlyph thread={thread("runtime", "Working")} />);
    const className = screen.getByRole("img").getAttribute("class") ?? "";
    expect(className).toContain("animate-spin");
    expect(className).not.toContain("animate-pulse");
  });

  it.each<PluginSidebarThreadIndicator>([
    "workflow",
    "background-agent",
    "background-command",
  ])("keeps %s on a gentle pulse (B66.5)", (indicator) => {
    render(<StatusGlyph thread={thread(indicator, "Label")} />);
    const className = screen.getByRole("img").getAttribute("class") ?? "";
    expect(className).toContain("animate-pulse");
    expect(className).not.toContain("animate-spin");
  });

  /** B66.6: motion means "happening right now"; a draft is not happening. */
  it.each<PluginSidebarThreadIndicator>([
    "plan-mode",
    "goal",
    "draft",
    "working-draft",
    "unread-success",
  ])("draws %s still (B66.6)", (indicator) => {
    render(<StatusGlyph thread={thread(indicator, "Label")} />);
    const className = screen.getByRole("img").getAttribute("class") ?? "";
    expect(className).not.toContain("animate-");
  });

  /** B66.3/B14: colour on the glyph only, and never a faded resting row. */
  it.each(PALETTE)("keeps %s colour off opacity (B66.3)", (indicator) => {
    const { container } = render(<StatusGlyph thread={thread(indicator, "Label")} />);
    expect(container.innerHTML).not.toContain("opacity-");
    expect(container.innerHTML).not.toContain("bg-");
  });

  it("draws nothing for idle", () => {
    render(<StatusGlyph thread={thread("none", null)} />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  /**
   * B20, the future-proofing test. bb adds indicator kinds over time; a value
   * outside today's union must draw nothing and throw nothing rather than
   * blanking the whole sidebar on some future bb release.
   */
  it("renders nothing and throws nothing for an unknown indicator (B20)", () => {
    const future = thread("none", "Something new");
    const unknown = {
      ...future,
      indicator: "quantum-mode" as never,
    } satisfies PluginSidebarThread;

    expect(() => render(<StatusGlyph thread={unknown} />)).not.toThrow();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
