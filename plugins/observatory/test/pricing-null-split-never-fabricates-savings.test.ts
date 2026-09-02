import { describe, expect, it } from "vitest";
import { priceTurn } from "../src/core/pricing.js";
import { bundledCatalog } from "../src/core/catalog.js";

const catalog = bundledCatalog();

const withoutSplit = {
  provider: "anthropic",
  model: "claude-opus-5",
  inputTokens: 1_000,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  cachedInputTokens: 110_000,
  outputTokens: 2_000,
  reasoningTokens: 0,
  loggedCostUsd: null,
};

// bb's usage event reports one `cachedInputTokens` with read and write already
// summed. A savings number is a claim about how much was WRITTEN versus
// re-read, and that is exactly the split that is missing: inventing a write
// share would put a made-up figure on the cost page under a confident heading.
describe("a turn with no cache split", () => {
  it("withholds the savings figure entirely", () => {
    const result = priceTurn(withoutSplit, catalog);

    expect(result.cacheSavingsUsd).toBeNull();
  });

  it("still prices, charging the cached total at the cache-read rate", () => {
    const result = priceTurn(withoutSplit, catalog);
    const priced = priceTurn(
      { ...withoutSplit, cacheReadTokens: 110_000, cacheWriteTokens: 0 },
      catalog,
    );

    expect(result.costSource).toBe("catalog");
    expect(result.costUsd).toBeCloseTo(priced.costUsd!, 10);
  });

  it("reports the savings once the split is actually known", () => {
    const result = priceTurn(
      { ...withoutSplit, cacheReadTokens: 100_000, cacheWriteTokens: 10_000 },
      catalog,
    );

    expect(result.cacheSavingsUsd).not.toBeNull();
    expect(result.cacheSavingsUsd!).toBeGreaterThan(0);
  });

  it("withholds the savings for an unresolvable model rather than reporting zero", () => {
    const result = priceTurn(
      { ...withoutSplit, provider: "nobody", model: "not-a-real-model-9", cacheReadTokens: 1, cacheWriteTokens: 1 },
      catalog,
    );

    expect(result.cacheSavingsUsd).toBeNull();
  });
});
