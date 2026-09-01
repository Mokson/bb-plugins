// Invariant: seat and tier come out of the title the delegate skill wrote.
// Per-seat and per-tier cost is the whole point of the ledger, and bb stores
// neither field.
import { describe, expect, it } from "vitest";
import { parseSeatAndTier } from "../src/core/threads.js";

describe("seat and tier from title", () => {
  it("reads the tier from the prefix without inventing a seat", () => {
    // The remainder of a delegate title is a task description, not a seat.
    // Storing it as one filled the seat column with unaggregatable one-offs.
    expect(parseSeatAndTier("[son5:low] map auth flows")).toEqual({
      seat: null,
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

  it("leaves an untagged title without a tier or a seat", () => {
    expect(parseSeatAndTier("just a chat")).toEqual({
      seat: null,
      tier_tag: null,
    });
    expect(parseSeatAndTier(null)).toEqual({ seat: null, tier_tag: null });
  });

  it("matches a seat only as a whole word", () => {
    // Substring matching turned every title merely mentioning a seat's name
    // into that seat's spend.
    expect(parseSeatAndTier("deliver-qa-notes cleanup")).toEqual({
      seat: null,
      tier_tag: null,
    });
    expect(parseSeatAndTier("predeliver-qa")).toEqual({
      seat: null,
      tier_tag: null,
    });
    expect(parseSeatAndTier("wrap up deliver-qa.")).toEqual({
      seat: "deliver-qa",
      tier_tag: null,
    });
  });
});
