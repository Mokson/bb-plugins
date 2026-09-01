// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { RenderRow } from "../model/types";
import { SecondRow, equalShrinkWeight } from "./SecondRow";

afterEach(cleanup);

function row(overrides: Partial<RenderRow> = {}): RenderRow {
  return {
    thread: {
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
      indicator: "none",
      indicatorLabel: null,
      isUnread: false,
      isPinned: false,
      isArchived: false,
      environment: null,
      host: null,
      createdAt: 0,
      updatedAt: 0,
      lastReadAt: null,
      latestAttentionAt: 0,
    },
    title: "Ship the sidebar",
    workspaceLabel: "feat/equal-truncation",
    depth: 0,
    childCount: 0,
    projectName: "bb-plugins",
    dimLevel: 0,
    sectionKey: "today",
    ...overrides,
  };
}

const baseProps = {
  row: row(),
  pullRequest: null,
  isCompactViewport: false,
  onOpenPullRequest: () => {},
  providerId: null,
  showProjectName: true,
  showBranch: true,
  showEffort: true,
  execution: { model: "claude-opus-5", reasoningLevel: "low" } as const,
};

function renderSecondRow(overrides: Partial<typeof baseProps> = {}) {
  return render(<SecondRow {...baseProps} {...overrides} />);
}

/**
 * Flexbox splits a deficit in proportion to `flex-shrink × flex-basis`, and
 * basis is natural width, so the weight each label is pinned with must make
 * that product constant across labels of different lengths. jsdom lays
 * nothing out, so the DOM half of the pass is driven by faking each label's
 * `offsetWidth` and re-rendering, which re-runs the pass.
 */
describe("SecondRow equal truncation", () => {
  it("renders the effort with the model, and the model alone when effort is off (B84)", () => {
    const { container, rerender } = renderSecondRow();
    const label = () =>
      container
        .querySelector<HTMLElement>("[data-better-sidebar-row2='model']")!
        .textContent;
    expect(label()).toBe("claude-opus-5 · low");

    rerender(<SecondRow {...baseProps} showEffort={false} />);
    expect(label()).toBe("claude-opus-5");
  });

  it("weights each label so its shrink × natural product is equal", () => {
    const { container, rerender } = renderSecondRow();
    const labels = container.querySelectorAll<HTMLElement>(
      "[data-better-sidebar-row2]",
    );
    // project, branch, model — deliberately unequal natural widths.
    const naturals = [60, 240, 120];
    expect(labels).toHaveLength(naturals.length);
    labels.forEach((el, i) =>
      Object.defineProperty(el, "offsetWidth", {
        value: naturals[i],
        configurable: true,
      }),
    );

    rerender(<SecondRow {...baseProps} />);

    const products = Array.from(labels).map(
      (el, i) => Number(el.style.flexShrink) * naturals[i],
    );
    for (const product of products) {
      expect(product).toBeCloseTo(products[0], 6);
    }
  });

  it("floors each label at the legibility minimum without padding it", () => {
    const { container, rerender } = renderSecondRow();
    const labels = container.querySelectorAll<HTMLElement>(
      "[data-better-sidebar-row2]",
    );
    // One label shorter than the floor: the floor must cap at its own
    // natural width, never stretch the box past its content.
    const naturals = [60, 240, 12];
    labels.forEach((el, i) =>
      Object.defineProperty(el, "offsetWidth", {
        value: naturals[i],
        configurable: true,
      }),
    );

    rerender(<SecondRow {...baseProps} />);

    const minWidths = Array.from(labels).map((el) =>
      Number.parseFloat(el.style.minWidth),
    );
    expect(minWidths[0]).toBeLessThanOrEqual(60);
    expect(minWidths[0]).toBeGreaterThan(0);
    expect(minWidths[0]).toBe(minWidths[1]);
    expect(minWidths[2]).toBe(12);
  });

  it("pins no weight when nothing is laid out", () => {
    // jsdom reports offsetWidth 0 for everything: a hidden row or a test DOM
    // must fall back to the class default rather than a weight on a guess.
    const { container } = renderSecondRow();
    for (const el of container.querySelectorAll<HTMLElement>(
      "[data-better-sidebar-row2]",
    )) {
      expect(el.style.flexShrink).toBe("");
      expect(el.style.minWidth).toBe("");
    }
  });

  describe("equalShrinkWeight", () => {
    it("makes the shrink × basis product constant across widths", () => {
      for (const natural of [40, 137, 480]) {
        expect(equalShrinkWeight(natural) * natural).toBeCloseTo(1000, 6);
      }
    });

    it("degrades to the flex default for a zero width", () => {
      expect(equalShrinkWeight(0)).toBe(1);
    });
  });
});
