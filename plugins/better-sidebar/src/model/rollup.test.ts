import { describe, expect, it } from "vitest";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { childrenByParent, rollUpIndicator, rollUpLabel } from "./rollup";

function thread(
  id: string,
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id,
    parentThreadId: null,
    indicator: "none",
    hasPendingInteraction: false,
    ...overrides,
  } as PluginSidebarThread;
}

/** The roll-up over a whole thread set, as the model builds it. */
function rollUp(threads: readonly PluginSidebarThread[], id: string) {
  const target = threads.find((entry) => entry.id === id)!;
  return rollUpIndicator(target, childrenByParent(threads));
}

describe("child-state roll-up (B87)", () => {
  it("reports a working child on an idle parent", () => {
    const threads = [
      thread("parent"),
      thread("kid", { parentThreadId: "parent", indicator: "background-agent" }),
    ];
    expect(rollUp(threads, "parent")).toBe("background-agent");
  });

  it("says nothing for a parent whose children are all idle", () => {
    const threads = [
      thread("parent"),
      thread("kid", { parentThreadId: "parent" }),
    ];
    expect(rollUp(threads, "parent")).toBeNull();
  });

  it("says nothing for a thread with no children at all", () => {
    expect(rollUp([thread("lonely")], "lonely")).toBeNull();
  });

  it("never overrides a parent that is doing something itself", () => {
    // The parent is running its own turn. Its own indicator is the truth, and
    // the roll-up must not replace it with a child's.
    const threads = [
      thread("parent", { indicator: "runtime" }),
      thread("kid", { parentThreadId: "parent", indicator: "workflow" }),
    ];
    expect(rollUp(threads, "parent")).toBeNull();
  });

  it("leaves a finished-but-unread parent alone", () => {
    // `unread-success` is not `none`: the parent has output the user has not
    // read, and that claim outranks a child's progress on this row.
    const threads = [
      thread("parent", { indicator: "unread-success" }),
      thread("kid", { parentThreadId: "parent", indicator: "runtime" }),
    ];
    expect(rollUp(threads, "parent")).toBeNull();
  });

  it("puts a BLOCKED child above any amount of work", () => {
    const threads = [
      thread("parent"),
      thread("busy", { parentThreadId: "parent", indicator: "runtime" }),
      thread("blocked", { parentThreadId: "parent", hasPendingInteraction: true }),
    ];
    expect(rollUp(threads, "parent")).toBe("waiting-for-input");
  });

  it("reads hasPendingInteraction even when the indicator has not caught up", () => {
    const threads = [
      thread("parent"),
      thread("kid", {
        parentThreadId: "parent",
        indicator: "runtime",
        hasPendingInteraction: true,
      }),
    ];
    expect(rollUp(threads, "parent")).toBe("waiting-for-input");
  });

  it("picks the busiest child when several are working", () => {
    const threads = [
      thread("parent"),
      thread("planning", { parentThreadId: "parent", indicator: "plan-mode" }),
      thread("running", { parentThreadId: "parent", indicator: "runtime" }),
      thread("shelling", { parentThreadId: "parent", indicator: "background-command" }),
    ];
    expect(rollUp(threads, "parent")).toBe("runtime");
  });

  it("ignores a child that is merely finished and unread", () => {
    // Otherwise the parent would draw the green unread dot, claiming IT had
    // output the user has not read.
    const threads = [
      thread("parent"),
      thread("kid", { parentThreadId: "parent", indicator: "unread-success" }),
    ];
    expect(rollUp(threads, "parent")).toBeNull();
  });

  it("reaches a grandchild, because a subagent can spawn its own", () => {
    const threads = [
      thread("parent"),
      thread("kid", { parentThreadId: "parent" }),
      thread("grandkid", { parentThreadId: "kid", indicator: "workflow" }),
    ];
    expect(rollUp(threads, "parent")).toBe("workflow");
  });

  it("terminates on a parent cycle rather than hanging the sidebar", () => {
    const threads = [
      thread("parent"),
      thread("a", { parentThreadId: "parent" }),
      thread("b", { parentThreadId: "a", indicator: "runtime" }),
    ];
    // Close the ring: `a`'s child `b` claims `a` as a child too.
    threads.push(thread("a2", { parentThreadId: "b" }));
    (threads[1] as { parentThreadId: string }).parentThreadId = "a2";
    expect(() => rollUp(threads, "parent")).not.toThrow();
  });

  it("names the children in its label, never the thread itself", () => {
    expect(rollUpLabel("waiting-for-input")).toBe("A child thread needs you");
    expect(rollUpLabel("runtime")).toBe("Child threads working");
  });
});
