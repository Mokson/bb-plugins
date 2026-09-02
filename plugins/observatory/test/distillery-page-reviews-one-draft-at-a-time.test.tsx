// @vitest-environment jsdom
// The motivating scenario end to end: a reviewer opens the distillery route,
// reads the one draft in front of them - before, correction, patch, rung -
// walks the queue with j and k, and clears it with a and r from the keyboard.
// Fixture mode stands in for the server half, which already ships on this
// branch behind `observatory_distill_*`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

// Spelled out rather than imported: `distillery-rpc.js` pulls
// `@get-bb/plugin-sdk/app` in, and evaluating that before `loadPluginApp`
// installs the runtime breaks the mount (the same reason `routes.ts` is kept
// free of it). This line is user-visible copy, so a literal is the assertion.
const EMPTY_MESSAGE = "queue empty, run bb observatory distill scan";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const mounted: Array<{ unmount(): void }> = [];

beforeEach(() => {
  window.history.replaceState({}, "", "/?fixture=1");
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()!.unmount();
});

async function mount(subPath = "distillery") {
  const app = await loadPluginApp(() => import("../src/app/app.js"));
  const slot = renderSlot(app.navPanels[0]!, { subPath }, { rpc: {} });
  mounted.push(slot);
  return slot;
}

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("the distillery queue", () => {
  it("heads the page with the counts and the top cluster signatures", async () => {
    const slot = await mount();
    await slot.findByText(/3 pending, 7 accepted, 4 applied, 9 clusters/);
    // Once as the top cluster, once as the first draft's own correction.
    expect(
      await slot.findAllByText("async call added without a teardown"),
    ).toHaveLength(2);
    await slot.findByText("6x / 4 runs");
  });

  it("shows one draft: before, correction, the diff, evidence and recurrence", async () => {
    const slot = await mount();
    await slot.findByText(/draft_fixture_1 - 1 of 3/);
    await slot.findByText("before");
    await slot.findByText("correction");
    await slot.findByText("proposed patch");
    const diff = slot.container.querySelector("pre");
    expect(diff?.className).toContain("font-mono");
    expect(diff?.textContent).toContain("+++ b/skills/deliver/craft-build.md");
    await slot.findByText(/evidence 101, 102, 103 - recurrence 2/);
    // The second draft is not on the page; this is a loop, not a list.
    expect(slot.queryByText(/draft_fixture_2/)).toBeNull();
  });

  it("names the stronger rung when the draft's own rung is prose", async () => {
    const slot = await mount();
    await slot.findByText(/reclassify to rung 3, repo lint, check or CI rule/);
  });

  it("falls back to rule text when the draft carries no patch", async () => {
    const slot = await mount();
    press("j");
    await slot.findByText("rule text");
    await slot.findByText(/A packet fact the seat re-derives/);
  });

  it("walks the queue with j and k", async () => {
    const slot = await mount();
    press("j");
    await slot.findByText(/draft_fixture_2 - 2 of 3/);
    press("j");
    await slot.findByText(/draft_fixture_3 - 3 of 3/);
    // j at the end of the queue holds position rather than blanking the page.
    press("j");
    await slot.findByText(/draft_fixture_3 - 3 of 3/);
    press("k");
    await slot.findByText(/draft_fixture_2 - 2 of 3/);
  });

  it("accepts and rejects from the keyboard, moving the counts with the list", async () => {
    const slot = await mount();
    press("a");
    await slot.findByText(/2 pending, 8 accepted/);
    await slot.findByText(/draft_fixture_2 - 1 of 2/);
    press("r");
    await slot.findByText(/1 pending, 8 accepted/);
    await slot.findByText(/draft_fixture_3 - 1 of 1/);
  });

  it("empties to one line naming the scan command", async () => {
    const slot = await mount();
    press("a");
    await slot.findByText(/draft_fixture_2/);
    press("r");
    await slot.findByText(/draft_fixture_3/);
    press("s");
    await slot.findByText(EMPTY_MESSAGE);
  });

  it("opens an inline textarea over the patch and saves through the edit action", async () => {
    const slot = await mount();
    press("e");
    const textarea = (await slot.findByRole("textbox", {
      name: "Edit proposed patch",
    })) as HTMLTextAreaElement;
    expect(textarea.value).toContain("+++ b/skills/deliver/craft-build.md");
    // Keys typed into the textarea are text, never commands.
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await slot.findByText(/draft_fixture_1/);
    (await slot.findByRole("button", { name: "save" })).click();
    await slot.findByText("proposed patch");
  });

  it("reports the written path when a draft is applied", async () => {
    const slot = await mount();
    (await slot.findByRole("button", { name: "apply" })).click();
    await slot.findByText(/wrote ~\/\.agents\/improvements\/fixture_draft_fixture_1\.md/);
  });

  it("lists the shortcut sheet on ?", async () => {
    const slot = await mount();
    expect(slot.queryByText("next draft")).toBeNull();
    press("?");
    await slot.findByRole("button", { name: "shortcuts", expanded: true });
    await slot.findByText("next draft");
    await slot.findByText("previous draft");
    press("?");
    await slot.findByRole("button", { name: "shortcuts", expanded: false });
    expect(slot.queryByText("next draft")).toBeNull();
  });

  it("keeps every table row at 24px", async () => {
    const slot = await mount();
    await slot.findByText("6x / 4 runs");
    const cells = Array.from(slot.container.querySelectorAll("tbody td"));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) expect(cell.className).toContain("h-6");
  });
});
