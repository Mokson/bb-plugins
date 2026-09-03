import assert from "node:assert/strict";
import test from "node:test";
import {
  formatResetsIn,
  formatResetsInShort,
  sidebarUsageShortLabel,
} from "../lib/sidebar-usage.ts";

test("formats reset countdowns like a human reads them", () => {
  const now = new Date("2026-09-03T10:00:00.000Z");
  assert.equal(
    formatResetsIn("2026-09-03T12:46:00.000Z", now),
    "Resets in 2h 46m",
  );
  assert.equal(formatResetsIn("2026-09-03T10:12:00.000Z", now), "Resets in 12m");
  assert.equal(
    formatResetsIn("2026-09-08T18:00:00.000Z", now),
    "Resets in 5d 8h",
  );
  assert.equal(
    formatResetsIn("2026-09-03T10:00:30.000Z", now),
    "Resets in 1m",
  );
  assert.equal(formatResetsIn("2026-09-03T09:00:00.000Z", now), "Resets soon");
  assert.equal(formatResetsIn(null, now), "Reset unavailable");
  assert.equal(formatResetsIn("not-a-date", now), "Reset unavailable");
});

test("formats short reset countdowns for the strip and compact rows", () => {
  const now = new Date("2026-09-03T10:00:00.000Z");
  assert.equal(
    formatResetsInShort("2026-09-03T12:46:00.000Z", now),
    "2h 46m",
  );
  assert.equal(
    formatResetsInShort("2026-09-03T13:00:00.000Z", now),
    "3h",
  );
  assert.equal(formatResetsInShort("2026-09-08T18:00:00.000Z", now), "5d 8h");
  assert.equal(formatResetsInShort("2026-09-03T10:42:00.000Z", now), "42m");
  assert.equal(formatResetsInShort("2026-09-03T09:00:00.000Z", now), "soon");
  assert.equal(formatResetsInShort(null, now), "");
  assert.equal(formatResetsInShort("bad", now), "");
});

test("shortens window labels for inline popover stats", () => {
  assert.equal(sidebarUsageShortLabel("5-hour limit"), "ses");
  assert.equal(sidebarUsageShortLabel("Five-hour limit"), "ses");
  assert.equal(sidebarUsageShortLabel("Weekly limit"), "wk");
  assert.equal(sidebarUsageShortLabel("7 day limit"), "wk");
  assert.equal(sidebarUsageShortLabel("Monthly limit"), "mo");
  assert.equal(sidebarUsageShortLabel("Fable"), "Fable");
});
