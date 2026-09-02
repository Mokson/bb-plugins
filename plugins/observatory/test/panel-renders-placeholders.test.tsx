// @vitest-environment jsdom
// The panel shell: one nav panel, and every route the plan names reachable
// from the tab strip. A route that renders nothing is a dead link a later
// phase would inherit.
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { ROUTES } from "../src/app/pages/routes.js";
import type { StatusView } from "../src/contract.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const STATUS: StatusView = {
  pluginId: "observatory",
  version: "0.0.1",
  installed: "/plugins/observatory/",
  modules: ["core", "spend", "watch", "context", "audit", "eval", "distillery"].map(
    (id) => ({
      id,
      enabled: true,
      source: "setting" as const,
      failures: 0,
      tripped: false,
      lastError: null,
    }),
  ),
  counts: { threads: 0, turns: 0, items: 0, openSignals: 0, actions: 0 },
  settings: [{ key: "watch.mode", value: "observe" }],
  generatedAt: "2026-09-01T00:00:00.000Z",
};

const rpc = { "observatory_status": () => STATUS };

// renderSlot mounts into document.body, so without this every later query in
// the file would match the previous test's DOM too.
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount();
});

async function mount(subPath: string) {
  const app = await loadPluginApp(() => import("../src/app/app.js"));
  const slot = renderSlot(app.navPanels[0]!, { subPath }, { rpc });
  mounted.push(slot);
  return { app, slot };
}

describe("the Observatory panel", () => {
  it("registers exactly one nav panel and one settings section", async () => {
    const { app } = await mount("");
    expect(app.navPanels).toHaveLength(1);
    expect(app.navPanels[0]!.title).toBe("Observatory");
    expect(app.navPanels[0]!.path).toBe("observatory");
    expect(app.settingsSections.map((section) => section.id)).toEqual([
      "observatory-settings",
    ]);
  });

  it("offers every route in the tab strip", async () => {
    const { slot } = await mount("");
    const tabs = Array.from(
      slot.container.querySelectorAll('[role="tab"]'),
      (tab) => tab.textContent,
    );
    expect(tabs).toEqual(ROUTES.map((route) => route.title));
    slot.unmount();
  });

  it("renders a heading on each non-inbox route", async () => {
    for (const route of ROUTES.filter((entry) => entry.id !== "")) {
      const { slot } = await mount(route.id);
      // A route with no heading is a blank page a later phase would inherit.
      await slot.findByRole("heading", { name: route.title });
    }
  });

  // The landing page is now the attention inbox, which belongs to the watch
  // module. With only `observatory_status` registered it has no data, and it
  // must say so rather than render zeros a reader would mistake for a
  // measurement. The `unknown_method` half of that rule is covered in
  // `watch-inbox-page-renders-fixture.test.tsx`.
  it("shows no counts on the inbox when the watch rpc does not answer", async () => {
    const { slot } = await mount("");
    await slot.findByRole("heading", { name: "Inbox" });
    expect(slot.queryByText("watched")).toBeNull();
    expect(slot.queryByText("stalled")).toBeNull();
    slot.unmount();
  });
});
