// @vitest-environment jsdom
// The context page's motivating scenario end to end: a reader opens the
// context route, reads what the project's prefix is made of, sees which pair
// is paid for twice and which skill is never read, and - with `?thread=` -
// how much a compaction of one thread would free. Fixture mode stands in for
// the live database, which is the same seam the cost page's test uses.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ESTIMATE_MARK } from "../src/app/lib/format.js";
import { readThreadFilter } from "../src/app/lib/filters.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mounted: Array<{ unmount(): void }> = [];

beforeEach(() => {
  window.history.replaceState({}, "", "/?fixture=1");
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount();
});

async function mount(subPath: string) {
  const app = await loadPluginApp(() => import("../src/app/app.js"));
  const slot = renderSlot(app.navPanels[0]!, { subPath }, { rpc: {} });
  mounted.push(slot);
  return slot;
}

describe("readThreadFilter", () => {
  it("reads the thread from the query and treats an empty value as absent", () => {
    expect(readThreadFilter("?thread=thr_1")).toBe("thr_1");
    expect(readThreadFilter("?thread=")).toBeNull();
    expect(readThreadFilter("?fixture=1")).toBeNull();
  });
});

describe("the context page", () => {
  it("shows the composition bar with a share per surface", async () => {
    const slot = await mount("context");
    const bar = await slot.findByRole("img", { name: /Prefix composition/ });
    const label = bar.getAttribute("aria-label") ?? "";
    for (const surface of ["instruction", "skill", "mcp", "plugin-tool"]) {
      expect(label).toContain(surface);
    }
    // One segment per surface present, each sized by its own share.
    expect(bar.children).toHaveLength(4);
  });

  it("marks every prefix token as an estimate and names the calibration", async () => {
    const slot = await mount("context");
    await slot.findByText("prefix est tok");
    expect(slot.container.textContent).toContain(ESTIMATE_MARK);
    await slot.findByText(/calibration source/);
  });

  it("lists the duplicate pair and the unused skill with what each costs", async () => {
    const slot = await mount("context");
    await slot.findByText(/fixture CLAUDE.md and fixture AGENTS.md/);
    await slot.findByText("recoverable tok");
    await slot.findByText("bytes saved");
    // Once in the block table as unused, once in the unused-skills table.
    expect(await slot.findAllByText("fixture archive skill")).toHaveLength(2);
  });

  it("adds the thread window and its compaction estimate under ?thread=", async () => {
    window.history.replaceState({}, "", "/?fixture=1&thread=thr_fixture_1");
    const slot = await mount("context");
    await slot.findByText("window used tok");
    await slot.findByText(/compaction would free about/);
  });

  it("keeps every table row 24px tall", async () => {
    const slot = await mount("context");
    await slot.findByText("fixture deliver skill");
    const cells = Array.from(slot.container.querySelectorAll("tbody td"));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell.className).toContain("h-6");
  });
});
