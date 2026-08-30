import { describe, expect, it } from "vitest";
import {
  DIM_FLOOR,
  bucketOf,
  dimLevelFor,
  isCollapsibleSection,
  labelFor,
  startOfLocalDay,
} from "./buckets";

/** Fixed local epochs — never Date.now(), so the midnight boundary is testable. */
const NOON = new Date(2026, 7, 30, 12, 0, 0, 0).getTime();
const MIDNIGHT = new Date(2026, 7, 30, 0, 0, 0, 0).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

describe("bucketOf (B2)", () => {
  it("puts one millisecond before local midnight in yesterday and one after in today", () => {
    const justAfter = MIDNIGHT + 1;
    expect(bucketOf(MIDNIGHT - 1, justAfter)).toBe("yesterday");
    expect(bucketOf(MIDNIGHT, justAfter)).toBe("today");
  });

  it("buckets by local calendar day, not by rolling 24h", () => {
    // 23h before noon is still 'yesterday' by calendar, though under 24h old.
    expect(bucketOf(NOON - 23 * 60 * 60 * 1000, NOON)).toBe("yesterday");
    expect(bucketOf(NOON - 60_000, NOON)).toBe("today");
  });

  it("steps through the rolling windows and lands everything else in older", () => {
    expect(bucketOf(NOON - 3 * DAY_MS, NOON)).toBe("last-7");
    expect(bucketOf(NOON - 7 * DAY_MS, NOON)).toBe("last-7");
    expect(bucketOf(NOON - 7 * DAY_MS - 1, NOON)).toBe("last-30");
    expect(bucketOf(NOON - 30 * DAY_MS, NOON)).toBe("last-30");
    expect(bucketOf(NOON - 30 * DAY_MS - 1, NOON)).toBe("older");
  });

  it("treats a future timestamp as today rather than throwing", () => {
    expect(bucketOf(NOON + DAY_MS, NOON)).toBe("today");
  });
});

describe("startOfLocalDay", () => {
  it("is idempotent and lands on local midnight", () => {
    expect(startOfLocalDay(NOON)).toBe(MIDNIGHT);
    expect(startOfLocalDay(MIDNIGHT)).toBe(MIDNIGHT);
  });
});

describe("dimLevelFor (B41 under the §7 ruling)", () => {
  it("never dims needs-you, pinned, today, search or the flat sections", () => {
    for (const key of ["needs-you", "pinned", "today", "search", "all"] as const) {
      expect(dimLevelFor(key)).toBe(0);
    }
    expect(dimLevelFor("project:p1")).toBe(0);
  });

  it("steps down with bucket age and floors at DIM_FLOOR", () => {
    expect(dimLevelFor("yesterday")).toBe(1);
    expect(dimLevelFor("last-7")).toBe(2);
    expect(dimLevelFor("last-30")).toBe(3);
    expect(dimLevelFor("older")).toBe(DIM_FLOOR);
  });
});

describe("labelFor / isCollapsibleSection (B7)", () => {
  it("resolves project sections through the project name map", () => {
    expect(labelFor("project:p1", new Map([["p1", "Better Sidebar"]]))).toBe(
      "BETTER SIDEBAR",
    );
    expect(labelFor("project:missing", new Map())).toBe("MISSING");
    expect(labelFor("last-7", new Map())).toBe("LAST 7 DAYS");
  });

  it("keeps needs-you and pinned non-collapsible", () => {
    expect(isCollapsibleSection("needs-you")).toBe(false);
    expect(isCollapsibleSection("pinned")).toBe(false);
    expect(isCollapsibleSection("today")).toBe(true);
    expect(isCollapsibleSection("project:p1")).toBe(true);
  });
});
