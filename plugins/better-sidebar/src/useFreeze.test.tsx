// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useFreeze, type FreezeInvalidators } from "./useFreeze";
import type { ListModel, RenderRow, SectionKey } from "./model/types";

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
