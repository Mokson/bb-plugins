// PRODUCT invariant 12: a missing price never becomes `$0.00`.
//
// The panel honours it and renders `--`; the agent tool handed the same scope
// back `{"spendUsd":0,...,"unpricedModels":1}`, and the model reading it wrote
// "all costs read 0" into its report (QA phase 1, H2). A zero is a
// measurement, so the totals that are sums over per-turn prices go null and
// the payload says why in one line.
import { describe, expect, it } from "vitest";
import { agentTotals } from "../src/spend/rollup.js";
import type { SpendTotals } from "../src/spend/contract.js";

const PRICED: SpendTotals = {
  spendUsd: 12.5,
  cacheSavedUsd: 3.25,
  cacheWriteUsd: 0.5,
  missCostUsd: 1,
  unpricedModels: 0,
};

describe("observatory_cost totals", () => {
  it("nulls spend and savings, and explains itself, when a model is unpriced", () => {
    const totals = agentTotals({ ...PRICED, unpricedModels: 1 });

    expect(totals.spendUsd).toBeNull();
    expect(totals.cacheSavedUsd).toBeNull();
    expect(totals.unpricedModels).toBe(1);
    expect(totals.note).toContain("null, not zero");
    // Priced from the catalog rather than from those turns, so they survive.
    expect(totals.cacheWriteUsd).toBe(0.5);
    expect(totals.missCostUsd).toBe(1);
  });

  it("passes a fully priced scope through untouched and unannotated", () => {
    expect(agentTotals(PRICED)).toEqual(PRICED);
  });

  it("keeps a measured zero, which is not the same as a missing price", () => {
    const totals = agentTotals({ ...PRICED, spendUsd: 0 });

    expect(totals.spendUsd).toBe(0);
    expect(totals.note).toBeUndefined();
  });
});
