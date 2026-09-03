// The export has to cover the slice the page is showing.
//
// Filtering to one provider and then exporting used to hand back every
// provider's rows, with a header that said nothing about it. Nobody reading
// that file a week later can tell it is wider than the question that produced
// it, so the totals in it are quietly wrong for the thing they were saved for.
import { afterEach, describe, expect, it } from "vitest";
import { spendExport } from "../src/spend/rollup.js";
import { TempDatabase } from "./fakes.js";
import { seedThread, seedTurn } from "./spend-fixtures.js";

const NOW = Date.parse("2026-08-31T12:00:00.000Z");

let temp: TempDatabase | undefined;
afterEach(() => {
  temp?.dispose();
  temp = undefined;
});

describe("spendExport", () => {
  it("emits only the filtered provider's rows and names the filter", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, {
      thread_id: "claude-thread",
      title: "claude work",
      provider_id: "claude-code",
    });
    seedThread(store, {
      thread_id: "codex-thread",
      title: "codex work",
      provider_id: "codex",
    });
    for (const thread of ["claude-thread", "codex-thread"]) {
      seedTurn(store, {
        thread_id: thread,
        turn_id: `${thread}-t1`,
        started_at: "2026-08-31T10:00:00.000Z",
        cost_usd: 1,
      });
    }

    const result = spendExport(
      { db: store.db, now: () => NOW },
      { range: "7d", group: "lineage", format: "md", provider: "codex" },
    );

    expect(result.content).toContain("codex work");
    expect(result.content).not.toContain("claude work");
    expect(result.content).toContain("provider: codex");
    // The unusable host filter still reports what it did: nothing.
    expect(result.content).toContain("host: all");
  });

  it("exports every provider when no filter is set", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, { thread_id: "a", title: "claude work" });
    seedThread(store, { thread_id: "b", title: "codex work", provider_id: "codex" });
    for (const thread of ["a", "b"]) {
      seedTurn(store, {
        thread_id: thread,
        turn_id: `${thread}-t1`,
        started_at: "2026-08-31T10:00:00.000Z",
        cost_usd: 1,
      });
    }

    const result = spendExport(
      { db: store.db, now: () => NOW },
      { range: "7d", group: "lineage", format: "md" },
    );

    expect(result.content).toContain("claude work");
    expect(result.content).toContain("codex work");
    expect(result.content).toContain("provider: all");
    expect(result.content).toContain("run: all");
  });

  it("emits only the run folder's rows and names the filter", () => {
    temp = new TempDatabase();
    const store = temp.open();
    seedThread(store, {
      thread_id: "in-run",
      title: "run work",
      run_folder: "/runs/OBS-1",
    });
    seedThread(store, { thread_id: "elsewhere", title: "other work" });
    for (const thread of ["in-run", "elsewhere"]) {
      seedTurn(store, {
        thread_id: thread,
        turn_id: `${thread}-t1`,
        started_at: "2026-08-31T10:00:00.000Z",
        cost_usd: 1,
      });
    }

    const result = spendExport(
      { db: store.db, now: () => NOW },
      { range: "7d", group: "lineage", format: "md", runFolder: "/runs/OBS-1" },
    );

    expect(result.content).toContain("run work");
    expect(result.content).not.toContain("other work");
    expect(result.content).toContain("run: /runs/OBS-1");
  });
});
