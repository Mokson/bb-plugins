import { describe, expect, it } from "vitest";
import { relativeTimeLabel } from "./relative-time";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("relativeTimeLabel", () => {
  const now = 1_700_000_000_000;

  it("reads 'now' under a minute", () => {
    expect(relativeTimeLabel(now, now)).toBe("now");
    expect(relativeTimeLabel(now - 59_000, now)).toBe("now");
  });

  it("steps through minutes, hours, days and weeks", () => {
    expect(relativeTimeLabel(now - 5 * MINUTE, now)).toBe("5m");
    expect(relativeTimeLabel(now - 2 * HOUR, now)).toBe("2h");
    expect(relativeTimeLabel(now - 3 * DAY, now)).toBe("3d");
    expect(relativeTimeLabel(now - 14 * DAY, now)).toBe("2w");
  });

  it("takes the lower unit exactly on a boundary", () => {
    expect(relativeTimeLabel(now - HOUR + 1, now)).toBe("59m");
    expect(relativeTimeLabel(now - HOUR, now)).toBe("1h");
  });

  /**
   * B12: a child's label is computed from its own timestamp, so a recent
   * child under an old parent is visibly recent rather than inheriting an age.
   */
  it("labels two threads independently of each other", () => {
    expect(relativeTimeLabel(now - 30 * DAY, now)).toBe("4w");
    expect(relativeTimeLabel(now - 2 * MINUTE, now)).toBe("2m");
  });
});
