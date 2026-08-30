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

const HUE_CLASSES = ["text-amber", "text-destructive", "text-emerald", "text-violet"];

function hasHue(element: Element): boolean {
  return HUE_CLASSES.some((hue) => element.getAttribute("class")?.includes(hue));
}

describe("StatusGlyph", () => {
  it("labels the glyph with the host's own indicatorLabel (B21)", () => {
    render(<StatusGlyph thread={thread("waiting-for-input", "Thread needs user input")} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe(
      "Thread needs user input",
    );
  });

  it("colours only needs-you and error (B22)", () => {
    render(<StatusGlyph thread={thread("waiting-for-input", "Needs you")} />);
    expect(hasHue(screen.getByRole("img"))).toBe(true);
    cleanup();

    render(<StatusGlyph thread={thread("unread-error", "Failed")} />);
    expect(hasHue(screen.getByRole("img"))).toBe(true);
  });

  it("distinguishes working by motion and no hue (B22)", () => {
    render(<StatusGlyph thread={thread("runtime", "Working")} />);
    const glyph = screen.getByRole("img");
    expect(glyph.getAttribute("class")).toContain("animate-pulse");
    expect(hasHue(glyph)).toBe(false);
  });

  it.each<PluginSidebarThreadIndicator>([
    "plan-mode",
    "goal",
    "draft",
    "working-draft",
    "unread-success",
  ])("draws %s monochrome and still", (indicator) => {
    render(<StatusGlyph thread={thread(indicator, "Label")} />);
    const glyph = screen.getByRole("img");
    expect(hasHue(glyph)).toBe(false);
    expect(glyph.getAttribute("class")).not.toContain("animate-pulse");
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
