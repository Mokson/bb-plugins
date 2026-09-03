import { describe, expect, it } from "vitest";
import { clockTime, progressLabel, relativeAge } from "./format";

const NOW = Date.parse("2026-09-03T12:00:00Z");

describe("relativeAge", () => {
  it("rounds down to the coarsest unit that fits", () => {
    expect(relativeAge(NOW - 30_000, NOW)).toBe("now");
    expect(relativeAge(NOW - 12 * 60_000, NOW)).toBe("12m");
    expect(relativeAge(NOW - 3 * 3_600_000, NOW)).toBe("3h");
    expect(relativeAge(NOW - 5 * 86_400_000, NOW)).toBe("5d");
  });

  it("falls back to a date past thirty days", () => {
    expect(relativeAge(Date.parse("2026-06-01T12:00:00Z"), NOW)).toBe("Jun 1");
  });

  it("returns nothing for a missing timestamp", () => {
    expect(relativeAge(0, NOW)).toBe("");
    expect(relativeAge(Number.NaN, NOW)).toBe("");
  });
});

describe("clockTime", () => {
  it("renders hours and minutes in the reader's zone", () => {
    expect(clockTime(Date.parse("2026-09-03T09:05:00Z"))).toBe("09:05 AM");
  });

  it("returns nothing for a missing timestamp", () => {
    expect(clockTime(0)).toBe("");
  });
});

describe("progressLabel", () => {
  it("is null before the pass has counted threads", () => {
    expect(progressLabel(0, 0)).toBeNull();
  });

  it("clamps a done count that overshoots", () => {
    expect(progressLabel(9, 5)).toBe("5/5 threads");
    expect(progressLabel(142, 316)).toBe("142/316 threads");
  });
});
