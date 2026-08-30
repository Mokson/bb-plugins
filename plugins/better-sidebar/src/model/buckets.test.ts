import { describe, expect, it } from "vitest";
import {
  DIM_FLOOR,
  bucketOf,
  dimLevelFor,
  isCollapsibleSection,
  labelFor,
  startOfLocalDay,
  statusGroupOf,
} from "./buckets";
import { NO_HOST_KEY, type SectionKey } from "./types";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

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
  it("resolves project sections through the dynamic label map", () => {
    expect(
      labelFor(
        "project:p1",
        new Map<SectionKey, string>([["project:p1", "Better Sidebar"]]),
      ),
    ).toBe("BETTER SIDEBAR");
    expect(labelFor("project:missing", new Map())).toBe("MISSING");
    expect(labelFor("last-7", new Map())).toBe("LAST 7 DAYS");
  });

  it("names the B67 band and the B65 groups without inventing new words", () => {
    expect(labelFor("done", new Map())).toBe("DONE");
    // B65.4: the same five words the row's glyph legend uses.
    expect(labelFor("status:needs-you", new Map())).toBe("NEEDS YOU");
    expect(labelFor("status:working", new Map())).toBe("WORKING");
    expect(labelFor("status:planning", new Map())).toBe("PLANNING");
    expect(labelFor("status:draft", new Map())).toBe("DRAFT");
    expect(labelFor("status:idle", new Map())).toBe("IDLE");
    // B67.7: the DONE band folds into this group in `status` mode.
    expect(labelFor("status:unread", new Map())).toBe("UNREAD");
    // B65.2: a null host is named, never dropped.
    expect(labelFor(NO_HOST_KEY, new Map())).toBe("NO MACHINE");
    expect(
      labelFor("host:h1", new Map<SectionKey, string>([["host:h1", "studio"]])),
    ).toBe("STUDIO");
  });

  it("makes DONE and the new group keys collapsible (B67.6)", () => {
    expect(isCollapsibleSection("done")).toBe(true);
    expect(isCollapsibleSection("status:working")).toBe(true);
    expect(isCollapsibleSection(NO_HOST_KEY)).toBe(true);
  });

  it("keeps needs-you and pinned non-collapsible", () => {
    expect(isCollapsibleSection("needs-you")).toBe(false);
    expect(isCollapsibleSection("pinned")).toBe(false);
    expect(isCollapsibleSection("today")).toBe(true);
    expect(isCollapsibleSection("project:p1")).toBe(true);
  });
});

describe("statusGroupOf (B65.4)", () => {
  function threadWith(overrides: Partial<PluginSidebarThread>): PluginSidebarThread {
    return {
      indicator: "none",
      hasPendingInteraction: false,
      ...overrides,
    } as PluginSidebarThread;
  }

  it("maps every indicator onto the row's own five-state vocabulary", () => {
    expect(statusGroupOf(threadWith({ indicator: "waiting-for-input" }))).toBe(
      "needs-you",
    );
    for (const indicator of [
      "runtime",
      "workflow",
      "background-agent",
      "background-command",
    ] as const) {
      expect(statusGroupOf(threadWith({ indicator }))).toBe("working");
    }
    expect(statusGroupOf(threadWith({ indicator: "plan-mode" }))).toBe("planning");
    expect(statusGroupOf(threadWith({ indicator: "goal" }))).toBe("planning");
    expect(statusGroupOf(threadWith({ indicator: "draft" }))).toBe("draft");
    expect(statusGroupOf(threadWith({ indicator: "working-draft" }))).toBe("draft");
    expect(statusGroupOf(threadWith({ indicator: "none" }))).toBe("idle");
  });

  it("folds both unread indicators into one group, which B67.7 merges DONE into", () => {
    expect(statusGroupOf(threadWith({ indicator: "unread-success" }))).toBe("unread");
    expect(statusGroupOf(threadWith({ indicator: "unread-error" }))).toBe("unread");
  });

  it("lets hasPendingInteraction outrank the indicator, as the band does", () => {
    expect(
      statusGroupOf(threadWith({ indicator: "runtime", hasPendingInteraction: true })),
    ).toBe("needs-you");
  });

  it("reads an unknown future indicator as idle rather than throwing (B20)", () => {
    expect(
      statusGroupOf(threadWith({ indicator: "not-a-real-kind" as never })),
    ).toBe("idle");
  });
});
