// Invariant: the exactness number is readable per provider.
//
// The bar this plugin is held to ("over 90% of claude-code turns log-exact")
// cannot be checked against a whole-ledger figure: a provider with no log
// parser contributes nothing but `unavailable` and drags a healthy provider
// under the bar, so the one number the tool printed could not answer the one
// question anyone asked of it.
import { describe, expect, it } from "vitest";
import { EventStore } from "../src/core/store-events.js";
import { formatCoverage } from "../src/server.js";
import { TempDatabase } from "./fakes.js";

function seed(store: ReturnType<TempDatabase["open"]>): void {
  store.upsertThread({ thread_id: "cc", provider_id: "claude-code" });
  store.upsertThread({ thread_id: "cur", provider_id: "acp-cursor" });
  for (const [turnId, split] of [
    ["cc-1", "log-exact"],
    ["cc-2", "log-exact"],
    ["cc-3", "log-window"],
  ] as const) {
    store.upsertTurn({ thread_id: "cc", turn_id: turnId, split_source: split });
  }
  store.upsertTurn({
    thread_id: "cur",
    turn_id: "cur-1",
    split_source: "unavailable",
  });
}

describe("coverage", () => {
  it("segments by provider and filters to one", () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      const events = new EventStore(store.db);
      seed(store);

      expect(events.coverage()).toMatchObject({ turns: 4, logExact: 2 });
      expect(events.coverageByProvider()).toEqual([
        {
          provider: "acp-cursor",
          turns: 1,
          logExact: 0,
          logWindow: 0,
          sidechain: 0,
          unavailable: 1,
        },
        {
          provider: "claude-code",
          turns: 3,
          logExact: 2,
          logWindow: 1,
          sidechain: 0,
          unavailable: 0,
        },
      ]);

      // `--provider` narrows both halves, so the headline share is that
      // provider's share rather than the ledger's.
      expect(events.coverage("claude-code")).toMatchObject({
        turns: 3,
        logExact: 2,
      });
      expect(
        events.coverageByProvider("claude-code").map((row) => row.provider),
      ).toEqual(["claude-code"]);
    } finally {
      temp.dispose();
    }
  });

  it("renders the per-provider block under the totals", () => {
    const temp = new TempDatabase();
    try {
      const store = temp.open();
      const events = new EventStore(store.db);
      seed(store);

      const text = formatCoverage(events.coverage(), events.coverageByProvider());

      expect(text).toContain("turns          4");
      expect(text).toContain("by provider");
      expect(text).toContain("claude-code");
      expect(text).toContain("66.7%");
      expect(text).toContain("acp-cursor");
    } finally {
      temp.dispose();
    }
  });
});
