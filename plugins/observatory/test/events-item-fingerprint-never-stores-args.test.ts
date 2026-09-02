// Invariant: an item row carries a fingerprint, never the arguments. The loop
// detector needs equality; keeping the payload would make this plugin a
// transcript store, which Max's rules forbid.
import { describe, expect, it } from "vitest";
import { emptyCarry, fingerprintArgs, normalizeEvents } from "../src/core/events.js";
import { event } from "./fakes.js";

const SECRET = "rm -rf /Users/secret/path --token=abc123";

describe("item fingerprints", () => {
  it("stores a hash and no argument text anywhere in the row", () => {
    const events = [
      event(1, "turn/started", { providerThreadId: "sess-1" }, { turnId: "t1" }),
      event(
        2,
        "item/completed",
        {
          providerThreadId: "sess-1",
          item: {
            type: "toolCall",
            id: "item-1",
            tool: "bash",
            arguments: { command: SECRET, cwd: "/tmp/one" },
            status: "completed",
          },
        },
        { turnId: "t1" },
      ),
    ];

    const result = normalizeEvents({
      threadId: "thr-1",
      events,
      carry: emptyCarry(),
    });

    const item = result.items[0];
    expect(item?.input_fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain("abc123");
  });

  // Verbatim from `bb thread log thr_yxmn5xqwic --json`: bb ships its built-in
  // tools with an empty argument record on both `item/started` and
  // `item/completed`. The input is not under another key; it never arrives.
  const bbSearchItem = (id: string) => ({
    type: "toolCall",
    id,
    tool: "search",
    arguments: {},
    status: "completed",
    result: '{"totalMatches":0,"truncated":false}',
    presentation: {
      label: { pending: "Searching", completed: "Searched" },
      icon: { glyph: "Search" },
      title: "grep",
    },
  });

  function itemsFor(items: Record<string, unknown>[]) {
    const events = [
      event(1, "turn/started", { providerThreadId: "sess-1" }, { turnId: "t1" }),
      ...items.map((item, index) =>
        event(
          index + 2,
          "item/completed",
          { providerThreadId: "sess-1", item },
          { turnId: "t1" },
        ),
      ),
    ];
    return normalizeEvents({ threadId: "thr-1", events, carry: emptyCarry() })
      .items;
  }

  it("leaves an item bb gave no input for unfingerprinted", () => {
    const items = itemsFor([bbSearchItem("item-1"), bbSearchItem("item-2")]);
    expect(items).toHaveLength(2);
    expect(items.map((row) => row.input_fingerprint ?? null)).toEqual([
      null,
      null,
    ]);
  });

  it("groups file items by path when there are no arguments", () => {
    const items = itemsFor([
      { type: "fileRead", id: "item-1", path: "src/a.ts", status: "completed" },
      { type: "fileRead", id: "item-2", path: "src/a.ts", status: "completed" },
      { type: "fileRead", id: "item-3", path: "src/b.ts", status: "completed" },
    ]);
    const [a, b, c] = items.map((row) => row.input_fingerprint);
    expect(a).toMatch(/^[0-9a-f]{64}$/u);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it("ignores volatile keys so the same call fingerprints the same", () => {
    const a = fingerprintArgs({ command: "npm  test", cwd: "/a", uuid: "1" });
    const b = fingerprintArgs({ command: "npm test", cwd: "/b", uuid: "2" });
    expect(a).toBe(b);
  });
});
