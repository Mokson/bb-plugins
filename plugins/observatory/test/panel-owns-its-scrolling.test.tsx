// @vitest-environment jsdom
// The panel scrolls, in both axes, inside the container bb gives it.
//
// bb mounts a nav panel into a bounded flex column that is `overflow-hidden`,
// so a panel root left in normal flow is clipped at that container's height
// and everything below the fold is unreachable - which is what a phone showed.
// The root therefore has to be the scroll container itself, and a table whose
// cells stay on one line has to carry its own sideways scroll rather than
// spilling into a page the host clips.
//
// These are class assertions rather than measurements on purpose: jsdom has no
// layout, so `scrollHeight` is zero for every element and a scroll test that
// read it would pass against the defect. The rendered proof is the mobile
// evidence in `docs/specs/OBS-1_observatory/evidence/mobile/`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { StatusView } from "../src/contract.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const STATUS: StatusView = {
  pluginId: "observatory",
  version: "0.0.1",
  installed: "/plugins/observatory/",
  modules: [],
  counts: { threads: 0, turns: 0, items: 0, openSignals: 0, actions: 0 },
  settings: [],
  generatedAt: "2026-09-01T00:00:00.000Z",
};

const rpc = { "observatory_status": () => STATUS };

const mounted: Array<{ unmount(): void }> = [];

// Fixture mode, the same way the page tests reach a populated table: the
// server half answers nothing here, and a skeleton has no table to scroll.
beforeEach(() => {
  window.history.replaceState({}, "", "/?fixture=1");
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount();
});

async function mount(subPath: string) {
  const app = await loadPluginApp(() => import("../src/app/app.js"));
  const slot = renderSlot(app.navPanels[0]!, { subPath }, { rpc });
  mounted.push(slot);
  return slot;
}

function panelRoot(slot: { container: HTMLElement }) {
  const root = slot.container.querySelector("[data-observatory-panel]");
  expect(root, "the panel renders a root element").not.toBeNull();
  return root as HTMLElement;
}

describe("the Observatory panel's scrolling", () => {
  it("makes its own root the vertical scroll container", async () => {
    const classes = panelRoot(await mount("")).className.split(/\s+/);

    // `min-h-0 flex-1` is what takes the host's bounded height instead of
    // growing past it; without both, `overflow-y-auto` has nothing to scroll
    // inside and the content is clipped exactly as before.
    expect(classes).toContain("min-h-0");
    expect(classes).toContain("flex-1");
    expect(classes).toContain("overflow-y-auto");
  });

  it("never pins the panel to the viewport's own height", async () => {
    const classes = panelRoot(await mount("")).className;

    // A viewport height on the root would scroll the wrong box on a phone,
    // where the browser chrome makes `100vh` taller than what the reader sees.
    expect(classes).not.toMatch(/h-screen|min-h-screen|h-\[100vh\]/);
  });

  it.each(["cost", "stalls", "context", "distillery"])(
    "scrolls the %s route's tables sideways inside their own block",
    async (route) => {
      const slot = await mount(route);
      await slot.findAllByRole("table");
      const tables = Array.from(slot.container.querySelectorAll("table"));

      for (const table of tables) {
        expect(
          table.parentElement?.className.split(/\s+/),
          `a table on ${route} sits in a sideways-scrolling block`,
        ).toContain("overflow-x-auto");
      }
    },
  );
});
