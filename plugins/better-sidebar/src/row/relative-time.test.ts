import { describe, expect, it } from "vitest";
import { durationLabel, relativeTimeLabel } from "./relative-time";

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

describe("durationLabel (B70.5)", () => {
  const now = 1_700_000_000_000;

  it("reads '<1m' under a minute, where an age would read 'now'", () => {
    expect(durationLabel(0)).toBe("<1m");
    expect(durationLabel(59_000)).toBe("<1m");
    // The whole reason it is a second function.
    expect(relativeTimeLabel(now, now)).toBe("now");
  });

  it("steps through minutes, hours, days and weeks", () => {
    expect(durationLabel(47 * MINUTE)).toBe("47m");
    expect(durationLabel(3 * HOUR)).toBe("3h");
    expect(durationLabel(2 * DAY)).toBe("2d");
    expect(durationLabel(14 * DAY)).toBe("2w");
  });

  it("takes the lower unit exactly on a boundary", () => {
    expect(durationLabel(HOUR - 1)).toBe("59m");
    expect(durationLabel(HOUR)).toBe("1h");
  });

  it("floors a negative span at zero rather than printing a minus sign", () => {
    expect(durationLabel(-5 * MINUTE)).toBe("<1m");
  });

  /** B70.1's two polarities, computed the way the chip computes them. */
  it("measures a running span from now and a finished span from updatedAt", () => {
    const createdAt = now - 47 * MINUTE;
    const updatedAt = now - 40 * MINUTE;
    expect(durationLabel(now - createdAt)).toBe("47m");
    expect(durationLabel(updatedAt - createdAt)).toBe("7m");
  });
});
