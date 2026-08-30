// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { reconcileSectionOrder, useSectionOrder } from "./useSectionOrder";
import type { SectionKey, SectionOrder } from "./model/types";

const NOW = new Date(2026, 7, 30, 12, 0, 0, 0).getTime();

function thread(
  id: string,
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id,
    latestAttentionAt: NOW,
    createdAt: NOW,
    ...overrides,
  } as PluginSidebarThread;
}

/** A stand-in section rule, so these tests exercise the reconciler alone. */
const inTodayOrPinned = (t: PluginSidebarThread): SectionKey =>
  t.isPinned ? "pinned" : "today";

/** Rendered order: newest entrant first (B68.2), `id` making it total. */
function order(state: SectionOrder, section: SectionKey): string[] {
  return [...state.entries]
    .filter(([, entry]) => entry.section === section)
    .sort(([leftId, left], [rightId, right]) =>
      left.sequence === right.sequence
        ? leftId.localeCompare(rightId)
        : right.sequence - left.sequence,
    )
    .map(([id]) => id);
}

afterEach(cleanup);

describe("reconcileSectionOrder (B68)", () => {
  it("seeds a first mount by latestAttentionAt desc, then createdAt, then id (B68.3)", () => {
    const threads = [
      thread("old", { latestAttentionAt: NOW - 2000 }),
      thread("new", { latestAttentionAt: NOW }),
      thread("mid", { latestAttentionAt: NOW - 1000 }),
    ];
    expect(order(reconcileSectionOrder(null, threads, inTodayOrPinned), "today")).toEqual(
      ["new", "mid", "old"],
    );
  });

  it("breaks a seed tie on createdAt, then on id ascending (B68.3)", () => {
    const threads = [
      thread("b", { createdAt: NOW - 1 }),
      thread("a", { createdAt: NOW - 1 }),
      thread("young", { createdAt: NOW }),
    ];
    expect(order(reconcileSectionOrder(null, threads, inTodayOrPinned), "today")).toEqual(
      ["young", "a", "b"],
    );
  });

  it("keeps a thread's sequence while it stays in its section (B68.1)", () => {
    const threads = [thread("a", { latestAttentionAt: NOW - 1 }), thread("b")];
    const first = reconcileSectionOrder(null, threads, inTodayOrPinned);
    // `a` is touched and now out-sorts `b`, and the order does not move.
    const bumped = [thread("a", { latestAttentionAt: NOW + 5000 }), thread("b")];
    const second = reconcileSectionOrder(first, bumped, inTodayOrPinned);
    expect(order(second, "today")).toEqual(order(first, "today"));
    expect(second.entries.get("a")).toBe(first.entries.get("a"));
  });

  it("puts a new entrant at the top of its section (B68.2)", () => {
    const first = reconcileSectionOrder(null, [thread("a"), thread("b")], inTodayOrPinned);
    const second = reconcileSectionOrder(
      first,
      [thread("a"), thread("b"), thread("late", { latestAttentionAt: NOW - 99999 })],
      inTodayOrPinned,
    );
    expect(order(second, "today")[0]).toBe("late");
    // Nothing already there moved relative to anything else.
    expect(order(second, "today").slice(1)).toEqual(order(first, "today"));
  });

  it("re-sequences a thread that changes section, and only then (B68.1)", () => {
    const threads = [thread("a"), thread("b")];
    const first = reconcileSectionOrder(null, threads, inTodayOrPinned);
    const pinned = [thread("a", { isPinned: true }), thread("b")];
    const second = reconcileSectionOrder(first, pinned, inTodayOrPinned);
    expect(second.entries.get("a")!.section).toBe("pinned");
    expect(second.entries.get("a")!.sequence).toBeGreaterThan(
      first.entries.get("a")!.sequence,
    );
    expect(second.entries.get("b")).toBe(first.entries.get("b"));
  });

  it("drops a departed thread, so a return is a new entrance (B68.6)", () => {
    const first = reconcileSectionOrder(null, [thread("a"), thread("b")], inTodayOrPinned);
    const gone = reconcileSectionOrder(first, [thread("b")], inTodayOrPinned);
    expect(gone.entries.has("a")).toBe(false);
    const back = reconcileSectionOrder(gone, [thread("a"), thread("b")], inTodayOrPinned);
    expect(back.entries.get("a")!.sequence).toBeGreaterThan(
      back.entries.get("b")!.sequence,
    );
  });

  it("assigns no new sequence when re-run on an unchanged input", () => {
    const threads = [thread("a"), thread("b")];
    const first = reconcileSectionOrder(null, threads, inTodayOrPinned);
    const again = reconcileSectionOrder(first, threads, inTodayOrPinned);
    expect(again.nextSequence).toBe(first.nextSequence);
    for (const [id, entry] of first.entries) expect(again.entries.get(id)).toBe(entry);
  });

  it("never decides which section a thread is in — it records the caller's answer", () => {
    const threads = [thread("a")];
    const first = reconcileSectionOrder(null, threads, () => "today");
    // The same thread, unchanged, with the caller's rule now saying otherwise.
    const second = reconcileSectionOrder(first, threads, () => "pinned");
    expect(second.entries.get("a")!.section).toBe("pinned");
  });
});

describe("useSectionOrder (B68.4)", () => {
  function Probe({ threads }: { threads: readonly PluginSidebarThread[] }) {
    const state = useSectionOrder(threads, inTodayOrPinned);
    return <span data-testid="order">{order(state, "today").join(",")}</span>;
  }

  it("holds the order across re-renders and re-seeds on a fresh mount", () => {
    const first = [thread("a", { latestAttentionAt: NOW }), thread("b")];
    const view = render(<Probe threads={first} />);
    expect(view.getByTestId("order").textContent).toBe("a,b");

    // `b` overtakes `a`; the mounted order is unmoved.
    view.rerender(
      <Probe threads={[thread("a"), thread("b", { latestAttentionAt: NOW + 1000 })]} />,
    );
    expect(view.getByTestId("order").textContent).toBe("a,b");

    // A remount is a reload: B68.4 re-seeds, and `b` is now genuinely first.
    cleanup();
    const remounted = render(
      <Probe threads={[thread("a"), thread("b", { latestAttentionAt: NOW + 1000 })]} />,
    );
    expect(remounted.getByTestId("order").textContent).toBe("b,a");
  });
});
