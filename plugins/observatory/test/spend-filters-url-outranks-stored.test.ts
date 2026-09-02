import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS,
  overviewInput,
  resolveFilters,
} from "../src/app/lib/filters.js";

const query = (search: string) => new URLSearchParams(search);

describe("filter precedence", () => {
  it("falls back to the defaults with no query and no storage", () => {
    expect(resolveFilters(query(""), null)).toEqual(DEFAULT_FILTERS);
  });

  it("uses the stored filters when the query names none", () => {
    expect(
      resolveFilters(query(""), { range: "30d", group: "model", host: "wyse" }),
    ).toEqual({ range: "30d", group: "model", host: "wyse", provider: "" });
  });

  it("lets the URL win over storage on every field", () => {
    const resolved = resolveFilters(
      query("?range=90d&group=day&host=laptop&provider=codex"),
      { range: "1d", group: "lineage", host: "wyse", provider: "claude-code" },
    );
    expect(resolved).toEqual({
      range: "90d",
      group: "day",
      host: "laptop",
      provider: "codex",
    });
  });

  it("treats an unrecognised query value as absent rather than an error", () => {
    expect(
      resolveFilters(query("?range=all-time&group=nonsense"), {
        range: "30d",
        group: "model",
      }),
    ).toMatchObject({ range: "30d", group: "model" });
  });

  it("discards a corrupt stored value down to the defaults", () => {
    expect(
      resolveFilters(query(""), { range: "yesterday" as never }),
    ).toMatchObject({ range: DEFAULT_FILTERS.range });
  });

  it("omits the empty host and provider from the rpc input", () => {
    expect(overviewInput(DEFAULT_FILTERS)).toEqual({
      range: "7d",
      group: "lineage",
    });
    expect(
      overviewInput({ ...DEFAULT_FILTERS, host: "wyse", provider: "codex" }),
    ).toEqual({
      range: "7d",
      group: "lineage",
      host: "wyse",
      provider: "codex",
    });
  });
});
