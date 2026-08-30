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

  it.each([
    ["merged tone", pr({ state: "merged", attention: "merged" }), "text-violet"],
    ["checks failed", pr({ attention: "checks_failed" }), "text-destructive"],
    ["conflicts", pr({ attention: "conflicts" }), "text-destructive"],
    ["ready to merge", pr({ attention: "ready_to_merge" }), "text-emerald"],
    ["anything else", pr({ attention: "checks_pending" }), "text-muted-foreground"],
  ])("tints by attention: %s (B34)", (_name, pullRequest, expected) => {
    render(
      <PrChip pullRequest={pullRequest} isCompactViewport={false} onOpen={() => {}} />,
    );
    expect(screen.getByRole("link").getAttribute("class")).toContain(expected);
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
