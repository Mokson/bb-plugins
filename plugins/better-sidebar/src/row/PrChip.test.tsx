// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PluginSidebarPullRequest } from "@get-bb/plugin-sdk/app";
import { PrChip } from "./PrChip";

afterEach(cleanup);

function pr(
  overrides: Partial<PluginSidebarPullRequest> = {},
): PluginSidebarPullRequest {
  return {
    number: 42,
    title: "Add the better sidebar",
    url: "https://github.test/org/repo/pull/42",
    state: "open",
    attention: "none",
    ...overrides,
  };
}

/**
 * `PrChip` takes its pull request as a prop and calls no hook, so it mounts
 * under a bare `render` with no host at all — that is what lets the row make
 * one `experimental_useSidebarThreadPullRequest` call and share it with the
 * context menu (§6).
 */
describe("PrChip", () => {
  it("renders #<number> with no host (B33)", () => {
    render(<PrChip pullRequest={pr()} isCompactViewport={false} onOpen={() => {}} />);
    expect(screen.getByRole("link").textContent).toContain("#42");
  });

  /**
   * B63, superseding B34. Colour answers "what is this PR" in GitHub's own
   * palette, so a hue means here what it means on github.com.
   */
  it.each([
    ["draft", pr({ state: "draft", attention: "draft" }), "text-muted-foreground"],
    ["open", pr({ state: "open", attention: "none" }), "text-emerald-600"],
    ["merged", pr({ state: "merged", attention: "merged" }), "text-violet-600"],
    ["closed", pr({ state: "closed", attention: "closed" }), "text-red-700"],
  ])("tints by state: %s (B63)", (_name, pullRequest, expected) => {
    render(
      <PrChip pullRequest={pullRequest} isCompactViewport={false} onOpen={() => {}} />,
    );
    expect(screen.getByRole("link").getAttribute("class")).toContain(expected);
  });

  /**
   * B63.1. The one case worth interrupting a glance, and the reason pure state
   * colouring was rejected: an open PR that is broken must not read green.
   */
  it.each<PluginSidebarPullRequest["attention"]>(["checks_failed", "conflicts"])(
    "renders an open PR red when %s (B63.1)",
    (attention) => {
      render(
        <PrChip
          pullRequest={pr({ state: "open", attention })}
          isCompactViewport={false}
          onOpen={() => {}}
        />,
      );
      const className = screen.getByRole("link").getAttribute("class") ?? "";
      expect(className).toContain("text-red-700");
      expect(className).not.toContain("text-emerald");
    },
  );

  /** B63.1 stops at `open`: a merged PR reads merged whatever broke on it. */
  it("keeps merged purple even with failed checks (B63.1)", () => {
    render(
      <PrChip
        pullRequest={pr({ state: "merged", attention: "checks_failed" })}
        isCompactViewport={false}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole("link").getAttribute("class")).toContain("text-violet-600");
  });

  /** B56.4: a truncated `#1234` is worse than useless, so the chip never shrinks. */
  it("never shrinks (B56.4)", () => {
    render(<PrChip pullRequest={pr()} isCompactViewport={false} onOpen={() => {}} />);
    expect(screen.getByRole("link").getAttribute("class")).toContain("shrink-0");
  });

  it("shows a rendered hover card, not a title attribute (B35)", async () => {
    render(
      <PrChip
        pullRequest={pr({ attention: "checks_failed" })}
        isCompactViewport={false}
        onOpen={() => {}}
      />,
    );

    const chip = screen.getByRole("link");
    expect(chip.getAttribute("title")).toBeNull();

    fireEvent.pointerOver(chip);
    expect(await screen.findByText("Checks failed", { exact: false })).toBeTruthy();
    expect(screen.getByText("Add the better sidebar")).toBeTruthy();
  });

  it("stays a plain link with no hover card on a compact viewport (B36)", () => {
    render(<PrChip pullRequest={pr()} isCompactViewport onOpen={() => {}} />);

    const chip = screen.getByRole("link");
    fireEvent.pointerOver(chip);
    expect(screen.queryByText("Add the better sidebar")).toBeNull();
  });

  it("stops the click reaching the row and calls onOpen once (B36)", () => {
    const onOpen = vi.fn();
    const onRowClick = vi.fn();
    render(
      <div onClick={onRowClick}>
        <PrChip pullRequest={pr()} isCompactViewport={false} onOpen={onOpen} />
      </div>,
    );

    fireEvent.click(screen.getByRole("link"));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});
