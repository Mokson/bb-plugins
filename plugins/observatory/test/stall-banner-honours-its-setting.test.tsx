// @vitest-environment jsdom
// The composer banner's kill switch: with `watch_stallBanner_enabled` unset it
// renders as before, and with it false the banner renders nothing even though
// the thread has an open stall. Fixture mode stands in for the watch rpc.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";

// The banner reads its thread from the composer view, which the test runtime
// has no real composer to answer. One fixture thread id, and a navigate stub,
// is all the component needs; every other hook comes from the real module.
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useComposerView: () => ({
      scope: { kind: "thread", threadId: "thr_fixture_1" },
    }),
    useBbNavigate: () => ({ toPluginPanel: () => {} }),
  };
});

installTestPluginRuntime();

import { StallBanner } from "../src/app/components/stall-banner.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mounted: Array<{ unmount(): void }> = [];

beforeEach(() => {
  window.history.replaceState({}, "", "/?fixture=1");
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount();
});

function mount(settings?: Record<string, string | boolean>) {
  const slot = renderSlot({ component: StallBanner }, {}, { settings });
  mounted.push(slot);
  return slot;
}

describe("the stalled banner's setting", () => {
  it("renders with its open-trajectory link by default", async () => {
    const slot = mount();
    await slot.findByText("open trajectory");
  });

  it("renders nothing when watch_stallBanner_enabled is false", async () => {
    const slot = mount({ watch_stallBanner_enabled: false });
    // The banner's whole DOM is one div; with the setting off it is empty.
    expect(slot.container.textContent).toBe("");
  });

  it("keeps rendering when the setting is explicitly true", async () => {
    const slot = mount({ watch_stallBanner_enabled: true });
    await slot.findByText("open trajectory");
  });
});
