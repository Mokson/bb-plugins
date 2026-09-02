import { describe, expect, it } from "vitest";
import {
  ESTIMATE_MARK,
  UNKNOWN,
  formatCount,
  formatDuration,
  formatPercent,
  formatTime,
  formatTokens,
  formatUsd,
} from "../src/app/lib/format.js";

describe("number formatting", () => {
  it("renders an unknown number as -- and never as zero", () => {
    expect(formatUsd(null)).toBe(UNKNOWN);
    expect(formatTokens(null)).toBe(UNKNOWN);
    expect(formatTokens(undefined)).toBe(UNKNOWN);
    expect(formatCount(Number.NaN)).toBe(UNKNOWN);
    expect(formatDuration(null)).toBe(UNKNOWN);
    expect(formatPercent(null)).toBe(UNKNOWN);
  });

  it("keeps a measured zero distinct from an unknown", () => {
    expect(formatUsd(0)).toBe("0.00");
    expect(formatTokens(0)).toBe("0");
  });

  it("marks an estimated number with a superscript e", () => {
    expect(formatTokens(1234, true)).toBe(`1,234${ESTIMATE_MARK}`);
    expect(formatUsd(1.5, true)).toBe(`1.50${ESTIMATE_MARK}`);
    expect(formatTokens(1234, false)).toBe("1,234");
  });

  it("never marks an unknown as estimated", () => {
    expect(formatUsd(null, true)).toBe(UNKNOWN);
  });

  it("keeps four decimals on a sub-cent bill", () => {
    expect(formatUsd(0.0037)).toBe("0.0037");
    expect(formatUsd(1.239)).toBe("1.24");
  });

  it("renders a duration in seconds and a timestamp in UTC", () => {
    expect(formatDuration(41_200)).toBe("41.2s");
    expect(formatTime("2026-09-01T09:00:00.000Z")).toBe("Sep 1, 09:00");
    expect(formatTime("not a date")).toBe(UNKNOWN);
  });

  it("climbs to the coarsest unit a long duration deserves", () => {
    expect(formatDuration(59_900)).toBe("59.9s");
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(30 * 60_000)).toBe("30m");
    expect(formatDuration(60 * 60_000)).toBe("1h");
    expect(formatDuration(72 * 60_000)).toBe("1h 12m");
    expect(formatDuration(24 * 3_600_000)).toBe("1d");
    expect(formatDuration(51 * 3_600_000)).toBe("2d 3h");
  });
});
