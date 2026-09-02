// PRODUCT invariant 33: path owns identity, query owns filters, filters
// persist, and the URL wins on conflict.
//
// `resolveFilters` held the precedence half from the start; nothing ever wrote
// the URL back, so selecting `1d` left `?range=7d` in the address bar and a
// reload snapped the view back to 7d (QA phase 1, M1). Round-tripping is what
// makes the precedence rule observable: what `filterSearch` writes has to be
// exactly what `resolveFilters` reads.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILTERS,
  filterSearch,
  resolveFilters,
  type Filters,
} from "../src/app/lib/filters.js";

describe("cost filters", () => {
  it("round-trips every filter through the query string", () => {
    const filters: Filters = {
      range: "1d",
      group: "day",
      host: "",
      provider: "anthropic",
    };

    const search = filterSearch(filters, "?range=7d&group=lineage");

    expect(new URLSearchParams(search).get("range")).toBe("1d");
    expect(resolveFilters(new URLSearchParams(search), null)).toEqual(filters);
  });

  it("keeps query parameters it does not own", () => {
    const search = filterSearch(DEFAULT_FILTERS, "?tab=cost&range=1d");

    expect(new URLSearchParams(search).get("tab")).toBe("cost");
    expect(new URLSearchParams(search).get("range")).toBe("7d");
  });

  it("drops an empty filter rather than writing one that matches nothing", () => {
    const search = filterSearch(DEFAULT_FILTERS, "?provider=anthropic&host=a");

    expect(new URLSearchParams(search).has("provider")).toBe(false);
    expect(new URLSearchParams(search).has("host")).toBe(false);
  });

  it("lets the URL beat the sticky value, in both directions", () => {
    const stored: Partial<Filters> = { range: "1d", group: "model" };

    expect(resolveFilters(new URLSearchParams("range=7d"), stored)).toMatchObject(
      { range: "7d", group: "model" },
    );
    // With nothing in the query the sticky value is the answer, which is what
    // makes the drilldown inherit the range it was opened from.
    expect(resolveFilters(new URLSearchParams(""), stored)).toMatchObject({
      range: "1d",
    });
  });
});
