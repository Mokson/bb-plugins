import { describe, expect, it } from "vitest";
import { bundledCatalog, resolveModel } from "../src/core/catalog.js";

const catalog = bundledCatalog();

// The ids the real logs carry are not the ids models.dev publishes. This
// machine's own sessions run `claude-opus-5[1m]`, and dated variants like
// `claude-sonnet-4-5-20250929` are everywhere. Without prefix matching the
// most expensive threads on the board would all price as `unknown`.
describe("model resolution", () => {
  it("matches an exact catalog id and says so", () => {
    const { price, status } = resolveModel(catalog, "anthropic", "claude-opus-5");

    expect(status).toBe("exact");
    expect(price!.input).toBeGreaterThan(0);
    expect(price!.cacheRead).toBeLessThan(price!.input);
  });

  it("resolves a 1M-context suffix to its base model, flagged as a prefix match", () => {
    const suffixed = resolveModel(catalog, "anthropic", "claude-opus-5[1m]");
    const base = resolveModel(catalog, "anthropic", "claude-opus-5");

    // models.dev publishes no `[1m]` entry today, so the honest answer is the
    // base rate with a status that does not claim to be exact.
    expect(suffixed.status).toBe("prefix");
    expect(suffixed.price).toEqual(base.price);
  });

  it("takes the LONGEST matching prefix, so a neighbour cannot swallow it", () => {
    // Two ids where one is a strict prefix of the other AND the prices differ,
    // so a shortest-match implementation would return the wrong rate.
    const table = {
      revision: "test",
      providers: {
        anthropic: {
          "claude-opus": { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
          "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        },
      },
    };

    const resolved = resolveModel(table, "anthropic", "claude-opus-5-20260101");

    expect(resolved.status).toBe("prefix");
    expect(resolved.price!.input).toBe(5);
  });

  it("resolves a dated variant that the catalog does not list", () => {
    const dated = resolveModel(catalog, "anthropic", "claude-opus-5-20260401");

    expect(dated.status).toBe("prefix");
    expect(dated.price).toEqual(resolveModel(catalog, "anthropic", "claude-opus-5").price);
  });

  it("maps this plugin's own provider tags onto real vendors", () => {
    // `claude-code` is a log root, not a vendor; nothing would resolve
    // without the alias.
    expect(resolveModel(catalog, "claude-code", "claude-opus-5").price).not.toBeNull();
  });

  it("strips a qualified id so an aggregator's model still resolves", () => {
    const qualified = resolveModel(catalog, "opencode", "anthropic/claude-opus-5");

    expect(qualified.price).not.toBeNull();
  });

  it("returns unknown rather than a guess for an unrecognised id", () => {
    const { price, status } = resolveModel(catalog, "anthropic", "zzz-not-a-model");

    expect(price).toBeNull();
    expect(status).toBe("unknown");
  });
});
