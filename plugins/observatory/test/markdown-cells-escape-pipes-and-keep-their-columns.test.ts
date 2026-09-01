// A thread title is free text, and a markdown table is parsed by position.
//
// One pipe in a title turns an eight-column COST.md row into nine columns for
// that row alone, so the retro seat reads the cost out of the flags cell. A
// newline is worse: it ends the row in the middle of the table. Both surfaces
// that render a table are pinned here, because they escape through the same
// helper and a fix to one silently leaves the other.
import { afterEach, describe, expect, it } from "vitest";
import { buildCostMd } from "../src/spend/cost-md.js";
import { overviewMarkdown, spendOverview } from "../src/spend/rollup.js";
import { TempDatabase } from "./fakes.js";
import { seedThread, seedTurn } from "./spend-fixtures.js";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");
const RUN_FOLDER = "/runs/OBS-1_observatory";
const NASTY_TITLE = "wave A | phase 2";

/** Cells of a rendered row, split on the pipes an escape did NOT neutralise. */
function columns(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split(/(?<!\\)\|/u);
}

let temp: TempDatabase | undefined;
afterEach(() => {
  temp?.dispose();
  temp = undefined;
});

describe("markdown table cells", () => {
  it("keeps a COST.md row at eight columns when the title holds a pipe", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, {
      thread_id: "impl",
      title: NASTY_TITLE,
      run_folder: RUN_FOLDER,
    });
    seedTurn(store, { thread_id: "impl", turn_id: "t1", cost_usd: 1.5 });

    const report = buildCostMd(store.db, {
      runFolder: RUN_FOLDER,
      now: () => NOW,
      readLedger: () => null,
    });

    const row = report.content
      .split("\n")
      .find((line) => line.includes("wave A"));
    expect(row).toBeDefined();
    expect(row).toContain("wave A \\| phase 2");
    expect(columns(row as string)).toHaveLength(8);
  });

  it("keeps an export row at eight columns when the label holds a pipe", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, { thread_id: "impl", title: NASTY_TITLE });
    seedTurn(store, {
      thread_id: "impl",
      turn_id: "t1",
      started_at: "2026-08-31T10:00:00.000Z",
      cost_usd: 1.5,
    });
    const query = { range: "7d" as const, group: "lineage" as const };

    const markdown = overviewMarkdown(
      spendOverview({ db: store.db, now: () => NOW }, query),
      query,
    );

    const row = markdown.split("\n").find((line) => line.includes("wave A"));
    expect(row).toBeDefined();
    expect(row).toContain("wave A \\| phase 2");
    expect(columns(row as string)).toHaveLength(8);
  });
});
