// Codex reports a cache READ and no cache write.
//
// Pricing treated the split as all-or-nothing: a null `cacheWrite` sent it
// down the "no split reported" branch, where it read `cachedInputTokens`
// instead. Codex never sets that field, so the read count was discarded and
// every Codex turn was billed on its uncached input alone. On a real trace
// that is a bill roughly two percent of the truth, because Codex re-sends the
// whole conversation and almost all of it is cached.
import { describe, expect, it } from "vitest";
import { priceTurn } from "../src/core/pricing.js";
import type { PricingCatalog } from "../src/core/catalog.js";

const catalog: PricingCatalog = {
  revision: "test",
  providers: {
    openai: {
      "gpt-5.6-sol": { input: 10, output: 40, cacheRead: 1, cacheWrite: 12.5 },
    },
  },
};

const codexTurn = {
  provider: "codex",
  model: "gpt-5.6-sol",
  // As the parser reports it: uncached input, the cached read, and no write.
  inputTokens: 2_699,
  cacheReadTokens: 139_008,
  cacheWriteTokens: null,
  cachedInputTokens: 0,
  outputTokens: 3_842,
  reasoningTokens: 3_636,
  loggedCostUsd: null,
};

describe("a Codex-shaped turn", () => {
  it("bills its cached read at the cache-read rate", () => {
    const priced = priceTurn(codexTurn, catalog);

    // 2,699 in + 139,008 read + (3,842 + 3,636) out, per million.
    const expected =
      (2_699 * 10 + 139_008 * 1 + (3_842 + 3_636) * 40) / 1_000_000;
    expect(priced.costUsd).toBeCloseTo(expected, 9);
    expect(priced.costSource).toBe("catalog");
    // The read dominates: dropping it is the difference the defect made.
    expect(priced.costUsd!).toBeGreaterThan(
      priceTurn({ ...codexTurn, cacheReadTokens: null }, catalog).costUsd!,
    );
  });

  it("still withholds a savings figure, because the write share is unknown", () => {
    // Savings is a claim about how much was WRITTEN versus re-read, and a null
    // write count is exactly that claim missing. Pricing the read is a
    // measurement; claiming the saving would be an invention.
    expect(priceTurn(codexTurn, catalog).cacheSavingsUsd).toBeNull();
    expect(
      priceTurn({ ...codexTurn, cacheWriteTokens: 0 }, catalog).cacheSavingsUsd,
    ).not.toBeNull();
  });
});
