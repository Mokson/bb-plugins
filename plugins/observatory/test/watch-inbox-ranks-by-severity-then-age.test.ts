// The inbox's whole promise is that the top row is the one that matters most
// (PRODUCT invariant 25). That is severity first, then oldest, then a stable
// tiebreak so a re-render never reshuffles equal rows under the cursor.
import { describe, expect, it } from "vitest";
import {
  isActionEnabled,
  matchesFilter,
  rankInboxRows,
  statusPhrase,
} from "../src/app/lib/inbox.js";
import type { InboxRow } from "../src/watch/contract.js";

function row(overrides: Partial<InboxRow>): InboxRow {
  return {
    id: "sig_1",
    source: "watch",
    kind: "stalled",
    title: "a thread",
    subtitle: "some evidence",
    threadId: "thr_1",
    severity: "warn",
    openedAt: "2026-09-01T09:00:00.000Z",
    actions: ["open"],
    ...overrides,
  };
}

describe("inbox ranking", () => {
  it("puts high above warn above info", () => {
    const ranked = rankInboxRows([
      row({ id: "a", severity: "info" }),
      row({ id: "b", severity: "high" }),
      row({ id: "c", severity: "warn" }),
    ]);
    expect(ranked.map((entry) => entry.id)).toEqual(["b", "c", "a"]);
  });

  it("puts the oldest signal first inside one severity", () => {
    const ranked = rankInboxRows([
      row({ id: "new", openedAt: "2026-09-01T10:00:00.000Z" }),
      row({ id: "old", openedAt: "2026-09-01T08:00:00.000Z" }),
    ]);
    expect(ranked.map((entry) => entry.id)).toEqual(["old", "new"]);
  });

  it("breaks a full tie on id, so the order is total", () => {
    const ranked = rankInboxRows([row({ id: "z" }), row({ id: "a" })]);
    expect(ranked.map((entry) => entry.id)).toEqual(["a", "z"]);
  });

  it("does not mutate the caller's list", () => {
    const rows = [row({ id: "a", severity: "info" }), row({ id: "b", severity: "high" })];
    rankInboxRows(rows);
    expect(rows.map((entry) => entry.id)).toEqual(["a", "b"]);
  });
});

describe("inbox display", () => {
  it("words the status column as source then kind", () => {
    expect(statusPhrase(row({ source: "spend", kind: "over-budget" }))).toBe(
      "spend over-budget",
    );
  });

  it("enables only the actions phase 2 can perform", () => {
    expect(isActionEnabled("open")).toBe(true);
    expect(isActionEnabled("review")).toBe(true);
    expect(isActionEnabled("steer")).toBe(false);
    expect(isActionEnabled("escalate")).toBe(false);
  });

  it("filters over the text a reader can see, case-insensitively", () => {
    const entry = row({ title: "Deliver Run", subtitle: "same test cmd x6" });
    expect(matchesFilter(entry, "")).toBe(true);
    expect(matchesFilter(entry, "  ")).toBe(true);
    expect(matchesFilter(entry, "deliver")).toBe(true);
    expect(matchesFilter(entry, "cmd x6")).toBe(true);
    expect(matchesFilter(entry, "watch stalled")).toBe(true);
    expect(matchesFilter(entry, "eval")).toBe(false);
  });
});
