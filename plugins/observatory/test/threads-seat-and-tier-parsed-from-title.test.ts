// Invariant: seat and tier come out of the title the delegate skill wrote.
// Per-seat and per-tier cost is the whole point of the ledger, and bb stores
// neither field.
import { describe, expect, it } from "vitest";
import { parseSeatAndTier } from "../src/core/threads.js";

describe("seat and tier from title", () => {
  it("splits the delegate `[model:effort]` prefix", () => {
    expect(parseSeatAndTier("[son5:low] map auth flows")).toEqual({
      seat: "map auth flows",
      tier_tag: "son5:low",
    });
  });

  it("prefers a deliver seat name wherever it appears", () => {
    expect(parseSeatAndTier("[opus5:high] deliver-implementer slice 2")).toEqual({
      seat: "deliver-implementer",
      tier_tag: "opus5:high",
    });
    expect(parseSeatAndTier("run deliver-qa over the branch")).toEqual({
      seat: "deliver-qa",
      tier_tag: null,
    });
  });

  it("leaves an untagged title without a tier", () => {
    expect(parseSeatAndTier("just a chat")).toEqual({
      seat: "just a chat",
      tier_tag: null,
    });
    expect(parseSeatAndTier(null)).toEqual({ seat: null, tier_tag: null });
  });
});
