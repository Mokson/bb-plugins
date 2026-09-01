import { describe, expect, it } from "vitest";
import { priceTurn } from "../src/core/pricing.js";
import { bundledCatalog } from "../src/core/catalog.js";

const catalog = bundledCatalog();

const base = {
  provider: "anthropic",
  model: "claude-opus-5",
  inputTokens: 1_000,
  cacheReadTokens: 100_000,
  cacheWriteTokens: 10_000,
  cachedInputTokens: 110_000,
  outputTokens: 2_000,
  reasoningTokens: 0,
  loggedCostUsd: null as number | null,
};

// Pi and OpenCode bill the call and write down what it cost. A catalog
// estimate on top of that is strictly worse information, so the ladder is
// logged, then catalog, then unpriceable, then unknown.
describe("cost precedence", () => {
  it("uses the provider's own figure when it reported one", () => {
    const result = priceTurn({ ...base, loggedCostUsd: 0.4242 }, catalog);

    expect(result.costUsd).toBe(0.4242);
    expect(result.costSource).toBe("logged");
    expect(result.pricingStatus).toBe("logged");
  });

  it("treats a reported zero as a real zero, not a missing figure", () => {
    // Locally hosted and included-plan models genuinely cost nothing.
    const result = priceTurn({ ...base, loggedCostUsd: 0 }, catalog);

    expect(result.costUsd).toBe(0);
    expect(result.costSource).toBe("logged");
  });

  it("falls back to the catalog when nothing was logged", () => {
    const result = priceTurn(base, catalog);

    expect(result.costSource).toBe("catalog");
    expect(result.costUsd).toBeGreaterThan(0);
  });

  it("returns a null cost for an unpriceable placeholder, never zero", () => {
    for (const model of ["<synthetic>", "opus", "anthropic/sonnet"]) {
      const result = priceTurn({ ...base, model }, catalog);

      // `$0.00` reads as free; only null reads as unmeasured.
      expect(result.costUsd).toBeNull();
      expect(result.costSource).toBe("unpriceable");
    }
  });

  it("returns a null cost for a model nothing resolves", () => {
    const result = priceTurn(
      { ...base, provider: "nobody", model: "not-a-real-model-9" },
      catalog,
    );

    expect(result.costUsd).toBeNull();
    expect(result.costSource).toBe("unknown");
    expect(result.pricingStatus).toBe("unknown");
  });
});
