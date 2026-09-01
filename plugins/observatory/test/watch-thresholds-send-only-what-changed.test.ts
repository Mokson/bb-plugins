// Writing a threshold stores a KV override that outranks the plugin setting
// (PRODUCT invariant 13). So sending back every row would silently convert the
// whole table to KV and detach it from settings. The diff is the guard.
import { describe, expect, it } from "vitest";
import {
  changedThresholds,
  discardDraft,
  hasChanges,
  parseDraft,
  thresholdRows,
  withDraft,
} from "../src/app/lib/thresholds.js";
import type { WatchSettings } from "../src/watch/contract.js";

const SETTINGS: WatchSettings = {
  mode: "observe",
  thresholds: { rule_silenceMinutes: 4, budget_perTreeUsd: 50 },
  source: { rule_silenceMinutes: "setting", budget_perTreeUsd: "kv" },
  note: null,
};

describe("the threshold table", () => {
  it("builds rows in key order with the source the server reported", () => {
    expect(thresholdRows(SETTINGS)).toEqual([
      { key: "budget_perTreeUsd", value: 50, draft: "50", source: "kv" },
      {
        key: "rule_silenceMinutes",
        value: 4,
        draft: "4",
        source: "setting",
      },
    ]);
  });

  it("falls back to setting for a key with no reported source", () => {
    const rows = thresholdRows({
      ...SETTINGS,
      source: {},
    });
    expect(rows.every((row) => row.source === "setting")).toBe(true);
  });
});

describe("the threshold diff", () => {
  it("sends nothing when nothing was edited", () => {
    const rows = thresholdRows(SETTINGS);
    expect(changedThresholds(rows)).toEqual({});
    expect(hasChanges(rows)).toBe(false);
  });

  it("sends only the row whose value actually differs", () => {
    const rows = withDraft(thresholdRows(SETTINGS), "rule_silenceMinutes", "6");
    expect(changedThresholds(rows)).toEqual({ rule_silenceMinutes: 6 });
    expect(hasChanges(rows)).toBe(true);
  });

  it("treats a retyped identical value as no edit", () => {
    const rows = withDraft(thresholdRows(SETTINGS), "budget_perTreeUsd", " 50 ");
    expect(changedThresholds(rows)).toEqual({});
  });

  // A reader who cleared a box to retype it has not asked for a threshold of
  // nothing, and `Number("")` is 0.
  it("ignores a blank or unparseable draft rather than sending zero", () => {
    expect(parseDraft("")).toBeNull();
    expect(parseDraft("   ")).toBeNull();
    expect(parseDraft("soon")).toBeNull();
    const rows = withDraft(thresholdRows(SETTINGS), "rule_silenceMinutes", "");
    expect(changedThresholds(rows)).toEqual({});
  });

  it("discards one row's edit without touching the others", () => {
    const edited = withDraft(
      withDraft(thresholdRows(SETTINGS), "rule_silenceMinutes", "6"),
      "budget_perTreeUsd",
      "80",
    );
    const rows = discardDraft(edited, "rule_silenceMinutes");
    expect(changedThresholds(rows)).toEqual({ budget_perTreeUsd: 80 });
  });
});
