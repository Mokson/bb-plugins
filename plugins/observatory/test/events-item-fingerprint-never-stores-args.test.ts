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

  it("ignores volatile keys so the same call fingerprints the same", () => {
    const a = fingerprintArgs({ command: "npm  test", cwd: "/a", uuid: "1" });
    const b = fingerprintArgs({ command: "npm test", cwd: "/b", uuid: "2" });
    expect(a).toBe(b);
  });
});
