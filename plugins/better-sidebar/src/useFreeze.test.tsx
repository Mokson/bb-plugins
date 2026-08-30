// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { useFreeze, type FreezeInvalidators } from "./useFreeze";
import { buildListModel } from "./model/list-model";
import type {
  ListModel,
  ListModelInput,
  RenderRow,
  SectionKey,
} from "./model/types";

/**
 * The snapshot only ever reads `thread.id` and the section key, so a row here
 * is exactly that much of a `RenderRow` — a full `PluginSidebarThread` would
 * assert nothing extra about the machine.
 */
function model(sections: readonly (readonly [SectionKey, readonly string[]])[]): ListModel {
  return {
    sections: sections.map(([key, ids]) => ({
      key,
      label: key,
      count: ids.length,
      isCollapsible: true,
      isCollapsed: false,
      rows: ids.map((id) => ({ thread: { id } }) as RenderRow),
    })),
    rowCount: sections.reduce((total, [, ids]) => total + ids.length, 0),
  };
}

const STABLE: FreezeInvalidators = { searchQuery: "", groupBy: "date", secondRow: "auto" };

function mount(invalidators: FreezeInvalidators = STABLE) {
  return renderHook((props: FreezeInvalidators) => useFreeze(props), {
    initialProps: invalidators,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useFreeze", () => {
  it("renders live until the pointer enters the list", () => {
    const { result } = mount();
    act(() => result.current.observe(model([["today", ["a", "b"]]])));
    expect(result.current.frozen).toBeNull();

    act(() => result.current.onPointerEnter());
    expect(result.current.frozen?.ids).toEqual(["a", "b"]);
  });

  it("pins the whole flattened sequence across sections, not one per section", () => {
    const { result } = mount();
    act(() =>
      result.current.observe(
        model([
          ["needs-you", ["a"]],
          ["today", ["b", "c"]],
        ]),
      ),
    );
    act(() => result.current.onPointerEnter());

    expect(result.current.frozen?.ids).toEqual(["a", "b", "c"]);
    expect(result.current.frozen?.sectionOf).toEqual({
      a: "needs-you",
      b: "today",
      c: "today",
    });
    expect(result.current.frozen?.sectionOrder).toEqual(["needs-you", "today"]);
  });

  it("holds the snapshot through the cooldown and drops it when it elapses", () => {
    const { result } = mount();
    act(() => result.current.observe(model([["today", ["a"]]])));
    act(() => result.current.onPointerEnter());
    act(() => result.current.onPointerLeave());

    // Split, because a timer scheduled inside an advance window does not fire
    // within that same call.
    act(() => void vi.advanceTimersByTime(1900));
    expect(result.current.frozen?.ids).toEqual(["a"]);

    act(() => void vi.advanceTimersByTime(200));
    expect(result.current.frozen).toBeNull();
  });

  it("keeps the OLD snapshot when the pointer returns during the cooldown", () => {
    const { result } = mount();
    act(() => result.current.observe(model([["today", ["a", "b"]]])));
    act(() => result.current.onPointerEnter());
    act(() => result.current.onPointerLeave());

    // A reorder that landed during the 2s gap must not be adopted on re-entry:
    // it would deliver the very jump the freeze exists to prevent.
    act(() => result.current.observe(model([["today", ["b", "a"]]])));
    act(() => void vi.advanceTimersByTime(1000));
    act(() => result.current.onPointerEnter());

    expect(result.current.frozen?.ids).toEqual(["a", "b"]);

    // …and re-entry cancelled the cooldown, so it never expires behind it.
    act(() => void vi.advanceTimersByTime(3000));
    expect(result.current.frozen?.ids).toEqual(["a", "b"]);
  });

  it("releases immediately when the search query changes", () => {
    const { result, rerender } = mount();
    act(() => result.current.observe(model([["today", ["a"]]])));
    act(() => result.current.onPointerEnter());
    expect(result.current.frozen).not.toBeNull();

    rerender({ ...STABLE, searchQuery: "ship" });
    expect(result.current.frozen).toBeNull();
  });

  it.each(["groupBy", "secondRow"] as const)("releases immediately when %s changes", (field) => {
    const { result, rerender } = mount();
    act(() => result.current.observe(model([["today", ["a"]]])));
    act(() => result.current.onPointerEnter());

    rerender({ ...STABLE, [field]: field === "groupBy" ? "project" : "always" });
    expect(result.current.frozen).toBeNull();
  });

  it("releases when the window blurs", () => {
    const { result } = mount();
    act(() => result.current.observe(model([["today", ["a"]]])));
    act(() => result.current.onPointerEnter());

    act(() => void window.dispatchEvent(new Event("blur")));
    expect(result.current.frozen).toBeNull();
  });

  it("releases on demand, for the thread the user is about to open", () => {
    const { result } = mount();
    act(() => result.current.observe(model([["today", ["a"]]])));
    act(() => result.current.onPointerEnter());

    act(() => result.current.release());
    expect(result.current.frozen).toBeNull();
  });

  it("does not re-capture while frozen, so a later reorder cannot leak in", () => {
    const { result } = mount();
    act(() => result.current.observe(model([["today", ["a", "b"]]])));
    act(() => result.current.onPointerEnter());
    act(() => result.current.observe(model([["today", ["b", "a"]]])));

    expect(result.current.frozen?.ids).toEqual(["a", "b"]);
  });

  it("clears its pending timer on unmount", () => {
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    const { result, unmount } = mount();
    act(() => result.current.observe(model([["today", ["a"]]])));
    act(() => result.current.onPointerEnter());
    act(() => result.current.onPointerLeave());

    unmount();
    expect(clearTimeout).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/**
 * F6: the machine and the overlay used to be tested only against each other's
 * stand-ins. These drive the REAL hook's `frozen` straight back into the REAL
 * `buildListModel`, over real threads, so a divergence between the two has
 * nowhere left to hide.
 */
describe("the real machine driving the real list model", () => {
  const NOW = new Date(2026, 7, 30, 12, 0, 0, 0).getTime();

  function thread(
    id: string,
    overrides: Partial<PluginSidebarThread> = {},
  ): PluginSidebarThread {
    return {
      id,
      projectId: "p1",
      title: id,
      titleFallback: null,
      parentThreadId: null,
      sectionId: null,
      originKind: null,
      originPluginId: null,
      providerId: "acp-claude",
      hasPendingInteraction: false,
      activity: {
        workflows: 0,
        backgroundAgents: 0,
        backgroundCommands: 0,
        planMode: 0,
        goals: 0,
      },
      indicator: "none",
      indicatorLabel: null,
      isUnread: false,
      isPinned: false,
      isArchived: false,
      environment: null,
      host: null,
      createdAt: NOW,
      updatedAt: NOW,
      lastReadAt: null,
      latestAttentionAt: NOW,
      ...overrides,
    };
  }

  function build(
    threads: readonly PluginSidebarThread[],
    overrides: Partial<ListModelInput> = {},
  ): ListModel {
    return buildListModel({
      threads,
      projects: [{ id: "p1", name: "Acme", isPersonal: false }],
      settings: { groupBy: "date", secondRow: "auto", tooltip: "rich" },
      searchQuery: "",
      now: NOW,
      frozen: null,
      collapsedSections: new Set<SectionKey>(),
      collapsedThreadIds: new Set<string>(),
      ...overrides,
    });
  }

  const sequence = (built: ListModel) =>
    built.sections.flatMap((section) => section.rows.map((row) => row.thread.id));

  it("pins the rendered order through a real observe → freeze → rebuild cycle", () => {
    const threads = [
      thread("a", { latestAttentionAt: NOW - 1000 }),
      thread("b", { latestAttentionAt: NOW - 2000 }),
      thread("c", { isPinned: true, latestAttentionAt: NOW - 3000 }),
    ];
    const { result } = mount();

    act(() => result.current.observe(build(threads)));
    act(() => result.current.onPointerEnter());
    const frozen = result.current.frozen;
    expect(frozen).not.toBeNull();

    // `b` overtakes `a` while the pointer is over the list.
    const bumped = threads.map((t) =>
      t.id === "b" ? thread("b", { latestAttentionAt: NOW }) : t,
    );
    expect(sequence(build(bumped))).toEqual(["c", "b", "a"]);
    expect(sequence(build(bumped, { frozen }))).toEqual(["c", "a", "b"]);
  });

  it("survives a subtree expanded while the real machine holds the freeze", () => {
    const threads = [
      thread("p", { latestAttentionAt: NOW - 1000 }),
      thread("kid", { parentThreadId: "p", latestAttentionAt: NOW - 1100 }),
      thread("tail", { latestAttentionAt: NOW - 5000 }),
    ];
    const { result } = mount();

    // Frozen while `p` is collapsed, exactly as the pointer reaches its chevron.
    act(() =>
      result.current.observe(build(threads, { collapsedThreadIds: new Set(["p"]) })),
    );
    act(() => result.current.onPointerEnter());
    expect(result.current.frozen?.ids).toEqual(["p", "tail"]);

    // Expanding is not an invalidator, so the freeze is still held.
    const expanded = build(threads, { frozen: result.current.frozen });
    expect(sequence(expanded)).toEqual(["p", "kid", "tail"]);
  });
});
