// @vitest-environment jsdom
// The audit pages' motivating scenario end to end: a reader opens the Audit
// tab, sees every session in the range, follows one to its metrics beside the
// 7-day median, then checks the failure ledger and the three insight facets.
// Fixture mode stands in for the live database.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { UNKNOWN } from "../src/app/lib/format.js";
import { muteExpiry, verificationVerdict } from "../src/app/lib/audit.js";

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

describe("verificationVerdict", () => {
  it("answers no only when there was command text to match against", () => {
    const base = { commands: 10, lastVerifiedAt: null };
    expect(
      verificationVerdict({
        ...base,
        verificationCommands: 2,
        textAvailable: true,
      }),
    ).toBe("yes");
    expect(
      verificationVerdict({
        ...base,
        verificationCommands: 0,
        textAvailable: true,
      }),
    ).toBe("no");
    expect(
      verificationVerdict({
        ...base,
        verificationCommands: 0,
        textAvailable: false,
      }),
    ).toBe(UNKNOWN);
  });
});

describe("muteExpiry", () => {
  it("always carries an expiry, one of the three offered durations out", () => {
    const now = new Date("2026-09-01T00:00:00.000Z");
    expect(muteExpiry(now, 1)).toBe("2026-09-02T00:00:00.000Z");
    expect(muteExpiry(now, 7)).toBe("2026-09-08T00:00:00.000Z");
    expect(muteExpiry(now, 30)).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("the audit sessions page", () => {
  it("defaults to the sessions tab and lists the sessions in range", async () => {
    const slot = await mount("audit");
    await slot.findByRole("heading", { name: "Audit" });
    await slot.findByText("fixture deliver run");
    await slot.findByText("fixture qa seat");
    // The session with no price reads as unknown, not as free.
    expect(slot.container.textContent).toContain(UNKNOWN);
  });

  it("opens one session's metrics beside the 7d median with the exports", async () => {
    const slot = await mount("audit/sessions/thr_fixture_1");
    await slot.findByText("7d median");
    await slot.findByText("delta");
    await slot.findByText("verification detected");
    await slot.findByText("unverified edits");
    await slot.findByRole("button", { name: "audit.json" });
    await slot.findByRole("button", { name: "audit.md" });
    await slot.findByText("no-verification");
  });
});

describe("the audit failures page", () => {
  it("lists each signature and opens its threads and mute control", async () => {
    const slot = await mount("audit/failures");
    const row = await slot.findByRole("button", {
      name: "fixture-provider-overloaded",
    });
    row.click();
    await slot.findByText(/fixture-model-sonnet/);
    await slot.findByText("not muted");
    await slot.findByRole("button", { name: "mute" });
    await slot.findByText(/mute for/);
  });

  it("keeps a muted signature on the page with its expiry", async () => {
    const slot = await mount("audit/failures");
    await slot.findByText("fixture-tool-timeout");
    await slot.findByText("tool, muted");
  });
});

describe("the audit insights page", () => {
  it("renders the three facets and marks the actionable rows", async () => {
    const slot = await mount("audit/insights");
    await slot.findByRole("heading", { name: "Cost drivers" });
    await slot.findByRole("heading", { name: "Seats" });
    await slot.findByRole("heading", { name: "Models" });
    const actions = Array.from(
      slot.container.querySelectorAll("tbody td"),
      (cell) => cell.textContent,
    ).filter((text) => text === "rule");
    expect(actions).toHaveLength(3);
  });
});
