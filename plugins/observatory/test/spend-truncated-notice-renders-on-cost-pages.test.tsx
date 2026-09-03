// @vitest-environment jsdom
// The spend rollups cap their payloads at 500 rows and say so with
// `truncated`, but no panel surface read that flag: a capped table rendered
// exactly like a complete one. Both cost pages now carry the one line that
// says the rows are capped and the totals complete.
//
// Mounted WITHOUT `?fixture=1` and with rpc handlers instead, so the flag
// can be set where a fixture cannot: the page fixtures never truncate.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { STORAGE_KEY } from "../src/app/lib/filters.js";
import {
  fixtureOverview,
  fixtureThread,
  FIXTURE_THREAD_ID,
} from "../src/app/fixtures/spend.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mounted: Array<{ unmount(): void }> = [];

beforeEach(() => {
  localStorage.removeItem(STORAGE_KEY);
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount();
});

async function mount(
  subPath: string,
  rpc: Record<string, () => unknown>,
) {
  const app = await loadPluginApp(() => import("../src/app/app.js"));
  const slot = renderSlot(app.navPanels[0]!, { subPath }, { rpc });
  mounted.push(slot);
  return slot;
}

describe("the truncation notice", () => {
  it("names the capped rows and the complete totals on the cost overview", async () => {
    const overview = { ...fixtureOverview(), truncated: true as const };
    const slot = await mount("cost", {
      observatory_spend_overview: () => overview,
    });
    await slot.findByText("fixture deliver run");
    await slot.findByText(
      `showing the first ${overview.rows.length} rows; totals cover all rows`,
    );
  });

  it("stays silent on the cost overview when nothing is capped", async () => {
    const slot = await mount("cost", {
      observatory_spend_overview: () => fixtureOverview(),
    });
    await slot.findByText("fixture deliver run");
    expect(slot.queryByText(/showing the first/u)).toBeNull();
  });

  it("names the capped turns and the complete totals on a thread page", async () => {
    const thread = { ...fixtureThread(), truncated: true as const };
    const slot = await mount(`threads/${FIXTURE_THREAD_ID}`, {
      observatory_spend_thread: () => thread,
    });
    await slot.findByRole("group", { name: "Cost by turn" });
    await slot.findByText(
      `showing the first ${thread.turns.length} turns; totals cover all turns`,
    );
  });
});
