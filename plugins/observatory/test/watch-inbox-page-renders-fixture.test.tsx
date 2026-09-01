// @vitest-environment jsdom
// The motivating scenario end to end: a reader lands on the panel, sees the
// counts and the ranked rows, filters the list, and follows a row to its
// thread. The stall monitor and the settings page ride the same fixture.
// Fixture mode stands in for the server half, which ships from a sibling seat.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
// React tracks a controlled input's value on the DOM node, so assigning
// `.value` and dispatching `input` by hand is silently ignored. `fireEvent`
// goes through the native setter, which is the only way to type into one.
import { fireEvent } from "@testing-library/react";
import { LADDER_TOOLTIP } from "../src/app/lib/inbox.js";
import { UNKNOWN } from "../src/app/lib/format.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mounted: Array<{ unmount(): void }> = [];

beforeEach(() => {
  window.history.replaceState({}, "", "/?fixture=1");
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount();
});

async function mount(
  subPath: string,
  rpc: Record<string, (input: unknown) => unknown> = {},
) {
  const app = await loadPluginApp(() => import("../src/app/app.js"));
  const slot = renderSlot(app.navPanels[0]!, { subPath }, { rpc });
  mounted.push(slot);
  return { app, slot };
}

describe("the attention inbox", () => {
  it("heads the page with today's spend and the watch counts", async () => {
    const { slot } = await mount("");
    await slot.findByText("today usd");
    await slot.findByText("watched");
    await slot.findByText("stalled");
    await slot.findByText("queue");
    // The fixture's four counts, as rendered hero numbers.
    await slot.findByText("4");
    await slot.findByText("2");
    await slot.findByText("3");
  });

  it("ranks the two high-severity rows above the warn and the info", async () => {
    const { slot } = await mount("");
    await slot.findByText("fixture deliver run");
    const titles = Array.from(
      slot.container.querySelectorAll("tbody tr td:first-child"),
      (cell) => cell.textContent,
    );
    expect(titles).toEqual([
      // Both high; the over-budget one opened 31 minutes ago, the stall 14.
      "fixture deliver run subtree",
      "fixture deliver run",
      "fixture implement seat",
      "fixture correction draft",
    ]);
  });

  it("words each row as source then kind with one evidence line", async () => {
    const { slot } = await mount("");
    await slot.findByText("spend over-budget");
    await slot.findByText("watch stalled");
    await slot.findByText("distillery draft-ready");
    await slot.findByText("same test command 6 times inside the last 20 items");
  });

  it("offers open and review, and disables the ladder rungs with their reason", async () => {
    const { slot } = await mount("");
    const open = await slot.findByRole("button", {
      name: "open fixture deliver run",
    });
    expect(open.hasAttribute("disabled")).toBe(false);
    const steer = await slot.findByRole("button", {
      name: "steer fixture deliver run",
    });
    expect(steer.hasAttribute("disabled")).toBe(true);
    expect(steer.getAttribute("title")).toBe(LADDER_TOOLTIP);
    const escalate = await slot.findByRole("button", {
      name: "escalate fixture deliver run",
    });
    expect(escalate.hasAttribute("disabled")).toBe(true);
  });

  it("filters the list down to the rows a reader typed for", async () => {
    const { slot } = await mount("");
    await slot.findByText("fixture correction draft");
    const filter = await slot.findByLabelText("Filter");
    fireEvent.change(filter, { target: { value: "implement" } });
    await slot.findByText("fixture implement seat");
    expect(slot.queryByText("fixture correction draft")).toBeNull();
  });

  it("keeps every row 24px tall, as the density contract requires", async () => {
    const { slot } = await mount("");
    await slot.findByText("fixture deliver run");
    const cells = Array.from(slot.container.querySelectorAll("tbody td"));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell.className).toContain("h-6");
  });

  // The server half ships from a sibling seat. Until it lands bb answers
  // `unknown_method`, and the page must say so rather than render zeros.
  it("says the watch module is not running instead of showing zeros", async () => {
    window.history.replaceState({}, "", "/");
    const { slot } = await mount("", {
      "observatory_inbox": () => {
        throw Object.assign(new Error("unknown_method"), {
          code: "unknown_method",
        });
      },
    });
    await slot.findByText("watch module not running");
    expect(slot.queryByText("watched")).toBeNull();
  });
});

describe("the stall monitor", () => {
  it("lists the stalled threads first, longest silence at the top", async () => {
    const { slot } = await mount("stalls");
    await slot.findByText("fixture deliver run");
    const titles = Array.from(
      slot.container.querySelectorAll("tbody tr td:first-child"),
      (cell) => cell.textContent,
    );
    expect(titles).toEqual(["fixture deliver run", "fixture implement seat"]);
  });

  it("shows silent time, the in-flight item, the stage and the diagnostic", async () => {
    const { slot } = await mount("stalls");
    await slot.findByText("14m");
    await slot.findByText("command npm test -- watch");
    await slot.findByText("verify");
    await slot.findByText(
      "no item for 14m with nothing in flight; the last command was the test run",
    );
    // A stalled thread with nothing in flight reads `--`, never "none".
    const inflight = Array.from(
      slot.container.querySelectorAll("tbody tr td:nth-child(5)"),
      (cell) => cell.textContent,
    );
    expect(inflight).toContain(UNKNOWN);
  });

  it("draws one silence timer bar per stalled row against the threshold", async () => {
    const { slot } = await mount("stalls");
    const bars = await slot.findAllByRole("img", { name: /^Silent / });
    expect(bars).toHaveLength(2);
    expect(bars[0]!.getAttribute("aria-label")).toBe(
      "Silent 14m against a 4m threshold",
    );
  });

  it("folds the healthy threads behind show all", async () => {
    const { slot } = await mount("stalls");
    expect(slot.queryByText("fixture qa seat")).toBeNull();
    const showAll = await slot.findByRole("button", {
      name: "show all (2 healthy)",
    });
    showAll.click();
    await slot.findByText("fixture qa seat");
  });

  // The plugin observes and advises; it never terminates agent work.
  it("offers no kill control anywhere on the page", async () => {
    const { slot } = await mount("stalls");
    await slot.findByText("fixture deliver run");
    expect(slot.container.textContent?.toLowerCase()).not.toContain("kill");
    expect(slot.container.textContent?.toLowerCase()).not.toContain("stop");
  });
});

describe("the trajectory tab", () => {
  it("marks the oscillating and looping turns in uppercase", async () => {
    const { slot } = await mount("threads/thr_fixture_1/trajectory");
    await slot.findByText("fixture deliver run");
    const markers = Array.from(
      slot.container.querySelectorAll("tbody tr td:nth-child(4)"),
      (cell) => cell.textContent,
    );
    expect(markers.join(" ")).toContain("LOOP");
    expect(markers.join(" ")).toContain("OSCILLATION");
    expect(markers.join(" ")).toContain("CONTEXT RESET");
  });

  it("attributes waste per rule and says the column does not sum", async () => {
    const { slot } = await mount("threads/thr_fixture_1/trajectory");
    await slot.findByText("waste attribution");
    await slot.findByText("repeated-identical-tool");
    await slot.findByText(/does not sum to the thread total/);
  });

  it("disables send to distillery with its reason", async () => {
    const { slot } = await mount("threads/thr_fixture_1/trajectory");
    const send = await slot.findByRole("button", {
      name: "send to distillery",
    });
    expect(send.hasAttribute("disabled")).toBe(true);
    expect(send.getAttribute("title")).toBe("distillery arrives in phase 6");
  });
});

describe("the watch settings page", () => {
  it("offers the three modes with the current one selected", async () => {
    const { slot } = await mount("settings");
    const observe = (await slot.findByLabelText(
      "observe",
    )) as HTMLInputElement;
    expect(observe.checked).toBe(true);
    await slot.findByLabelText("off");
    await slot.findByLabelText("steer");
  });

  it("shows each threshold's source and offers a reset only on a KV row", async () => {
    const { slot } = await mount("settings");
    await slot.findByLabelText("rule_silenceMinutes");
    await slot.findByRole("button", {
      name: "Reset budget_perTreeUsd to setting",
    });
    // `rule_silenceMinutes` comes from the setting, so there is nothing to
    // reset it to.
    expect(
      slot.queryByRole("button", {
        name: "Reset rule_silenceMinutes to setting",
      }),
    ).toBeNull();
  });

  it("keeps save disabled until a threshold actually changes", async () => {
    const { slot } = await mount("settings");
    const save = await slot.findByRole("button", { name: "save thresholds" });
    expect(save.hasAttribute("disabled")).toBe(true);
    const box = await slot.findByLabelText("rule_silenceMinutes");
    fireEvent.change(box, { target: { value: "6" } });
    await slot.findByText("1 changed");
    expect(
      (await slot.findByRole("button", { name: "save thresholds" })).hasAttribute(
        "disabled",
      ),
    ).toBe(false);
  });
});
