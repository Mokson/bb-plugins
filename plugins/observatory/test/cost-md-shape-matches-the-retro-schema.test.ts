// `COST.md` has one consumer with one requirement: the retro seat parses it
// without editing it. So this test is a BYTE comparison against a golden file
// plus independent structural assertions — the golden alone would happily
// bless a regenerated wrong shape, and the structure alone would miss a
// spacing change that breaks a parser.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { COST_MD_FLAGS, buildCostMd } from "../src/spend/cost-md.js";
import { TempDatabase } from "./fakes.js";
import {
  COST_MD_NOW,
  LEDGER,
  RUN_FOLDER,
  seedCostMdRun,
} from "./cost-md-fixture.js";
import { seedThread, seedTurn } from "./spend-fixtures.js";

const EXPECTED = readFileSync(
  fileURLToPath(new URL("./fixtures/cost-md/expected.md", import.meta.url)),
  "utf8",
);

let temp: TempDatabase | undefined;
afterEach(() => {
  temp?.dispose();
  temp = undefined;
});

function build(): string {
  const store = (temp as TempDatabase).open();
  seedCostMdRun(store);
  return buildCostMd(store.db, {
    runFolder: RUN_FOLDER,
    now: () => COST_MD_NOW,
    readLedger: () => LEDGER,
  }).content;
}

function tableRows(content: string): string[][] {
  return content
    .split("\n")
    .slice(10)
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
}

describe("COST.md", () => {
  it("matches the retro schema byte for byte", () => {
    temp = new TempDatabase();
    expect(build()).toBe(EXPECTED);
  });

  it("keeps the seven header keys in order and the eight-column header", () => {
    temp = new TempDatabase();
    const lines = build().split("\n");

    expect(lines.slice(0, 7).map((line) => line.split(":")[0])).toEqual([
      "snapshot",
      "generated_at",
      "agents",
      "cost_usd_total",
      "tokens_total",
      "cache_read_tokens",
      "cache_read_share",
    ]);
    expect(lines[7]).toBe("");
    expect(lines[8]).toBe(
      "| agent | model | effort | stage | tool uses | duration s | cost usd | flags |",
    );
    expect(lines[9]).toBe("| --- | --- | --- | --- | --- | --- | --- | --- |");
  });

  it("sorts rows by cost descending and fills unmatched cells with n/a", () => {
    temp = new TempDatabase();
    const rows = tableRows(build());

    expect(rows).toHaveLength(11);
    expect(rows.every((row) => row.length === 8)).toBe(true);
    const costs = rows.map((row) => Number(row[6]));
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
    // The subagent has no runlog entry, so its stage is n/a, not a guess.
    expect(rows.find((row) => row[0] === "probe")?.[3]).toBe("n/a");
    // ...and the seats that DO have one are resolved from the ledger runlog.
    expect(rows.find((row) => row[0] === "deliver-qa")?.[3]).toBe("qa");
  });

  it("emits nothing outside the closed flag vocabulary", () => {
    temp = new TempDatabase();
    const emitted = new Set(
      tableRows(build()).flatMap((row) => {
        const cell = row[7] ?? "";
        return cell === "n/a" ? [] : cell.split(" ");
      }),
    );

    for (const flag of emitted) {
      expect(COST_MD_FLAGS as readonly string[]).toContain(flag);
    }
    // ...and the vocabulary is exercised rather than vacuously empty.
    expect([...emitted].sort()).toEqual([
      "high-turns",
      "mismatch",
      "nested",
      "tier-policy",
    ]);
  });

  it("flags the seat whose tier tag the modal model contradicts, not the one turn that strayed", () => {
    temp = new TempDatabase();
    const rows = tableRows(build());

    // The implementer declared son5 and ran opus throughout.
    expect(rows.find((row) => row[0] === "deliver-implementer")?.[7]).toBe(
      "tier-policy",
    );
    // QA declared hai5 and ran haiku, apart from one turn: mismatch only.
    expect(rows.find((row) => row[0] === "deliver-qa")?.[7]).not.toContain(
      "tier-policy",
    );
  });

  it("stays a valid file with agents: 0 when the run folder matches nothing", () => {
    temp = new TempDatabase();
    const store = temp.open();
    const report = buildCostMd(store.db, {
      runFolder: "/runs/nothing-here",
      now: () => COST_MD_NOW,
      readLedger: () => null,
    });

    expect(report.agents).toBe(0);
    expect(report.content).toContain("agents: 0");
    expect(report.content).toContain(
      "| agent | model | effort | stage | tool uses | duration s | cost usd | flags |",
    );
    // No turns means no tokens, and a share over zero tokens is unmeasured.
    expect(report.content).toContain("cache_read_share: n/a");
  });

  it("reports the split as n/a rather than the reads it happens to know", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, { thread_id: "impl", run_folder: RUN_FOLDER });
    seedTurn(store, {
      thread_id: "impl",
      turn_id: "a",
      cache_read_tokens: 1_000,
      cache_write_tokens: 10,
      input_tokens: 100,
      cost_usd: 1,
      cost_source: "logged",
    });
    seedTurn(store, {
      thread_id: "impl",
      turn_id: "b",
      cache_read_tokens: null,
      cached_input_tokens: 9_999,
      input_tokens: 100,
      split_source: "unavailable",
      cost_usd: 1,
      cost_source: "logged",
    });

    const content = buildCostMd(store.db, {
      runFolder: RUN_FOLDER,
      now: () => COST_MD_NOW,
      readLedger: () => null,
    }).content;

    expect(content).toContain("cache_read_tokens: n/a");
    expect(content).toContain("cache_read_share: n/a");
  });

  it("says mid-run while any selected thread is still active", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, {
      thread_id: "impl",
      run_folder: RUN_FOLDER,
      status: "active",
    });
    seedTurn(store, { thread_id: "impl", turn_id: "a", cost_usd: 1 });

    expect(
      buildCostMd(store.db, {
        runFolder: RUN_FOLDER,
        now: () => COST_MD_NOW,
        readLedger: () => null,
      }).content,
    ).toContain("snapshot: mid-run");
  });
});
