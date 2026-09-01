// `COST.md` has one consumer with one requirement: the retro seat parses it
// without editing it. So this test is a BYTE comparison against a golden file
// plus independent structural assertions — the golden alone would happily
// bless a regenerated wrong shape, and the structure alone would miss a
// spacing change that breaks a parser.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  COST_MD_FLAGS,
  buildCostMd,
  parseLedgerStages,
} from "../src/spend/cost-md.js";
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

  it("reads the stage from a bullet runlog as well as a pipe table", () => {
    // The shape every real ledger in the corpus actually uses: the stage
    // leads the row and the fields after it are the lookup keys.
    const stages = parseLedgerStages(
      [
        "## Runlog",
        "",
        "- implement | stage workers queued+groom | bb-thread | thr_cckww2a73g | claude-opus-5 | low | accepted",
        "- fix | park-hold on stage selection | orchestrator | n/a | claude-fable-5 | session | accepted",
        // Prose with a pipe in it is not a row.
        "- see the table above | nothing here",
        "",
      ].join("\n"),
    );

    expect(stages.get("thr_cckww2a73g")).toBe("implement");
    expect(stages.get("orchestrator")).toBe("fix");
    // `n/a` is never a key: it would map every unmatched row to one stage.
    expect(stages.has("n/a")).toBe(false);
    expect(stages.has("nothing here")).toBe(false);
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

  // QA phase 1, H1: the header both suppressed the cache reads as unknown and
  // counted them inside `tokens_total`, so its two cache keys were unusable
  // and its token total was 40x the input+output it claimed to be.
  it("reports a partial split as a floor and keeps it out of tokens_total", () => {
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

    // The reads one turn proved, marked as the floor they are.
    expect(content).toContain("cache_read_tokens: 1000+");
    // Input + output + reasoning only. The 1,000 reads and the 9,999 unsplit
    // cached tokens are NOT in here; counting them while printing the same
    // reads as unknown is the contradiction this test exists for.
    expect(content).toContain("tokens_total: 200");
    // 1000 / (200 + 1000), and a floor too.
    expect(content).toContain("cache_read_share: 83.3%+");
  });

  it("reports the split as n/a only when no turn proved one", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, { thread_id: "impl", run_folder: RUN_FOLDER });
    seedTurn(store, {
      thread_id: "impl",
      turn_id: "a",
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
