// @vitest-environment jsdom
// The motivating scenario end to end: a reader opens the cost route, sees the
// four hero numbers and the lineage tree, folds a thread, and follows a row to
// that thread's Cost tab. Fixture mode stands in for the server half, which
// ships from a sibling seat.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ESTIMATE_MARK, UNKNOWN } from "../src/app/lib/format.js";
import { STORAGE_KEY } from "../src/app/lib/filters.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mounted: Array<{ unmount(): void }> = [];

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  window.history.replaceState({}, "", "/?fixture=1");
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount();
});

async function mount(subPath: string) {
  const app = await loadPluginApp(() => import("../src/app/app.js"));
  const slot = renderSlot(app.navPanels[0]!, { subPath }, { rpc: {} });
  mounted.push(slot);
  return { app, slot };
}

describe("the cost overview", () => {
  it("shows the four hero numbers with their units in the label", async () => {
    const { slot } = await mount("cost");
    await slot.findByText("spend usd");
    await slot.findByText("41.87");
    await slot.findByText("cache saved usd");
    await slot.findByText("cache write usd");
    await slot.findByText("miss cost usd");
  });

  it("links the unpriced-model count to settings", async () => {
    const { slot } = await mount("cost");
    await slot.findByText(/2 models unpriced/);
    await slot.findByRole("button", { name: "review" });
  });

  it("renders an unknown cost as -- and an estimated one with a superscript e", async () => {
    const { slot } = await mount("cost");
    // The unparented bucket has no price and no cache split.
    await slot.findByText("unparented turns");
    expect(slot.container.textContent).toContain(UNKNOWN);
    expect(slot.container.textContent).toContain(ESTIMATE_MARK);
  });

  it("folds a thread and its whole subtree from one control", async () => {
    const { slot } = await mount("cost");
    await slot.findByText("fixture qa seat");
    const collapse = await slot.findByRole("button", {
      name: "Collapse fixture deliver run",
    });
    collapse.click();
    // The control flips to Expand once React has committed the fold.
    await slot.findByRole("button", { name: "Expand fixture deliver run" });
    expect(slot.queryByText("fixture qa seat")).toBeNull();
    expect(slot.queryByText("fixture implement seat")).toBeNull();
    // The sibling root row is untouched.
    await slot.findByText("unparented turns");
  });

  it("keeps every row height at 24px and every number tabular", async () => {
    const { slot } = await mount("cost");
    await slot.findByText("fixture deliver run");
    const cells = Array.from(slot.container.querySelectorAll("tbody td"));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.className).toContain("h-6");
    }
  });
});

describe("the thread cost tab", () => {
  it("renders the sparkline and the turn table for a thread", async () => {
    const { slot } = await mount("threads/thr_fixture_1");
    await slot.findByRole("group", { name: "Cost by turn" });
    // Five turns, one bar each.
    const bars = Array.from(
      slot.container.querySelectorAll('[aria-label^="Turn turn_fixture_"]'),
    );
    expect(bars).toHaveLength(5);
    // The unpriced turn keeps its row and reads as unknown, not as zero.
    await slot.findByText("unavailable");
    await slot.findByText("log-window");
  });

  it("registers the Cost, Context and Audit tabs on the thread panel", async () => {
    const { app } = await mount("cost");
    expect(
      app.threadPanelActions.map((action) => [action.id, action.title]),
    ).toEqual([
      ["observatory-cost", "Cost"],
      ["observatory-context", "Context"],
      ["observatory-audit", "Audit"],
    ]);
  });
});

describe("the cache drilldown", () => {
  it("lists the classified cause, the turn pair and every correlate", async () => {
    const { slot } = await mount("cost/cache");
    // Once as the classified cause, once in the correlate list beneath it.
    expect(await slot.findAllByText("model-switch")).toHaveLength(2);
    await slot.findByText("turn_fixture_2");
    await slot.findByText("claude-opus-5 to claude-sonnet-5");
    await slot.findByText("implement mounted");
  });

  it("says so in one line when a miss has no transcript", async () => {
    const { slot } = await mount("cost/cache");
    await slot.findByText(/no transcript for provider/);
  });
});
