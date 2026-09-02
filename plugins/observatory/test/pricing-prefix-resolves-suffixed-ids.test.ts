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

  it("refuses to price a 1M-context id at its base model's rate", () => {
    // The long-context tier bills at a premium the base entry does not carry,
    // and models.dev publishes no `[1m]` entry to read it from. Falling back
    // to the base rate understates the bill on precisely the most expensive
    // threads on the board, so the honest answer is that we do not know.
    const suffixed = resolveModel(catalog, "anthropic", "claude-opus-5[1m]");

    expect(suffixed.status).toBe("unknown");
    expect(suffixed.price).toBeNull();
  });

  it("prices a 1M-context id the moment a catalog carries it explicitly", () => {
    // The guard is about a missing rate, not about the suffix: an exact entry
    // outranks it and nothing is withheld.
    const table = {
      revision: "test",
      providers: {
        anthropic: {
          "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
          "claude-opus-5[1m]": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
        },
      },
    };

    const resolved = resolveModel(table, "anthropic", "claude-opus-5[1m]");

    expect(resolved.status).toBe("exact");
    expect(resolved.price!.input).toBe(10);
  });

  it("will not let a shorter id swallow an unrelated longer model", () => {
    // `startsWith` alone matches `claude-sonnet-4` against `claude-sonnet-45`
    // and prices a model nobody published at another model's rate. A prefix is
    // only a prefix when what follows it is a SUFFIX: a delimiter, and after a
    // hyphen a date or a named variant rather than a version fragment.
    const table = {
      revision: "test",
      providers: {
        anthropic: {
          "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        },
      },
    };

    expect(resolveModel(table, "anthropic", "claude-sonnet-45").status).toBe(
      "unknown",
    );
    expect(resolveModel(table, "anthropic", "claude-sonnet-45").price).toBeNull();
    // A neighbouring version is not a variant of its predecessor either.
    expect(resolveModel(table, "anthropic", "claude-sonnet-4-5").price).toBeNull();
    // ...while a real dated variant still resolves.
    expect(
      resolveModel(table, "anthropic", "claude-sonnet-4-20250514").price,
    ).not.toBeNull();
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
