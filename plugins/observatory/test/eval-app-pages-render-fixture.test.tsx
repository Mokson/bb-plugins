// @vitest-environment jsdom
// The motivating scenario end to end: a reader opens the eval route, sees the
// case list with its last verdicts as words, follows a case to its detail and
// its run history, and opens the run to find which assertion failed. Fixture
// mode stands in for the server half.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { UNKNOWN } from "../src/app/lib/format.js";
import { FIXTURE_CASE_NAME, FIXTURE_RUN_ID } from "../src/app/fixtures/eval.js";

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

describe("the eval cases route", () => {
  it("lists every case with its last verdict as an uppercase word", async () => {
    const slot = await mount("eval");
    await slot.findByRole("button", { name: FIXTURE_CASE_NAME });
    await slot.findByText("PASS");
    expect(await slot.findAllByText("FAIL")).not.toHaveLength(0);
    // No case row carries a colour class: the verdict is the word.
    expect(slot.container.innerHTML).not.toMatch(/text-(red|green|amber|yellow)/);
  });

  it("keeps an unparseable case as a row and names the offending key", async () => {
    const slot = await mount("eval");
    await slot.findByRole("button", { name: "fixture-groom-shape" });
    await slot.findByText("assert.trace.max_turnz: unrecognized key");
  });

  it("shows the parsed case body on the detail view", async () => {
    const slot = await mount(`eval/cases/${FIXTURE_CASE_NAME}`);
    await slot.findByText("deliver the fixture backlog item");
    await slot.findByText("fixture0000000000000000000000000000000a1");
    // The assertion KEYS, not their values: the case file owns those.
    await slot.findByText("ledger artifacts trace");
    // `trials` comes off the body now rather than reading `--`.
    await slot.findByText("3");
  });

  it("shows the parse error instead of a body when the case did not parse", async () => {
    const slot = await mount("eval/cases/fixture-groom-shape");
    await slot.findByText("assert.trace.max_turnz: unrecognized key");
    expect(slot.container.textContent).not.toContain("base branch");
  });

  it("lists the recent runs beside the cases", async () => {
    const slot = await mount("eval");
    await slot.findByRole("button", { name: FIXTURE_RUN_ID });
    expect(await slot.findAllByText("nightly")).not.toHaveLength(0);
  });

  it("shows one case with its path and the runs that selected it", async () => {
    const slot = await mount(`eval/cases/${FIXTURE_CASE_NAME}`);
    await slot.findByText(/\/fixture\/eval\/cases\/deliver-normal\.yaml/);
    await slot.findByText("Run history");
    await slot.findByRole("button", { name: FIXTURE_RUN_ID });
  });

  it("says so in one line when the case name is unknown", async () => {
    const slot = await mount("eval/cases/fixture-no-such-case");
    await slot.findByText(/no case named fixture-no-such-case/);
  });
});

describe("the eval run route", () => {
  it("heads the run with its gate, cost and wall", async () => {
    const slot = await mount(`eval/runs/${FIXTURE_RUN_ID}`);
    await slot.findByText("gate");
    expect(await slot.findAllByText("cost usd")).not.toHaveLength(0);
    await slot.findByText("10.52");
    expect(await slot.findAllByText("wall")).not.toHaveLength(0);
    await slot.findByText(/9f3c1ab/);
  });

  it("indents every failed assertion under its trial row", async () => {
    const slot = await mount(`eval/runs/${FIXTURE_RUN_ID}`);
    await slot.findByText(/trace\.max_cost_usd 6\.40 over the 5\.00 ceiling/);
    await slot.findByText(/output\.contains missing: regression test/);
    // A passing assertion is not listed: the page is read to find what broke.
    expect(slot.container.textContent).not.toContain("ledger.exists");
  });

  it("keeps a trial whose metrics never landed and reads it as unknown", async () => {
    const slot = await mount(`eval/runs/${FIXTURE_RUN_ID}`);
    const rows = Array.from(slot.container.querySelectorAll("tbody tr"));
    expect(rows.length).toBeGreaterThan(2);
    expect(slot.container.textContent).toContain(UNKNOWN);
  });

  it("states the drift thresholds and that promotion is CLI only", async () => {
    const slot = await mount(`eval/runs/${FIXTURE_RUN_ID}`);
    await slot.findByText(/tokens \+50%, cost \+40%, wall \+60%/);
    await slot.findByText(
      /bb observatory eval baseline promote <run>/,
    );
  });

  it("marks WARN on every delta that clears the gate's threshold", async () => {
    const slot = await mount(`eval/runs/${FIXTURE_RUN_ID}`);
    // fixture-deliver-bug clears all three DRIFT ceilings against its baseline.
    await slot.findByText("+75% WARN");
    await slot.findByText("+60% WARN");
    await slot.findByText("+73% WARN");
    // fixture-deliver-normal drifts a few points and stays quiet.
    await slot.findByText("+7%");
    expect(slot.container.textContent).toContain("run_fixture_0");
  });

  it("keeps every row height at 24px", async () => {
    const slot = await mount(`eval/runs/${FIXTURE_RUN_ID}`);
    await slot.findAllByText("fixture-deliver-bug");
    const cells = Array.from(slot.container.querySelectorAll("tbody td"));
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell.className).toContain("h-6");
    }
  });
});
