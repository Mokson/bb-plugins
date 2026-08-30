// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useCollapse } from "./useCollapse";

const SECTIONS_KEY = "better-sidebar:collapsed-sections";
const THREADS_KEY = "better-sidebar:collapsed-threads";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(cleanup);

describe("useCollapse", () => {
  it("starts with nothing collapsed", () => {
    const { result } = renderHook(() => useCollapse());
    expect(result.current.collapsedSections.size).toBe(0);
    expect(result.current.collapsedThreadIds.size).toBe(0);
  });

  it("toggles a section and survives a remount by reading localStorage back", () => {
    const first = renderHook(() => useCollapse());
    act(() => first.result.current.toggleSection("last-7"));
    expect(first.result.current.collapsedSections.has("last-7")).toBe(true);
    expect(window.localStorage.getItem(SECTIONS_KEY)).toBe('["last-7"]');

    first.unmount();
    const second = renderHook(() => useCollapse());
    expect(second.result.current.collapsedSections.has("last-7")).toBe(true);
  });

  it("toggles a section back off", () => {
    const { result } = renderHook(() => useCollapse());
    act(() => result.current.toggleSection("last-7"));
    act(() => result.current.toggleSection("last-7"));
    expect(result.current.collapsedSections.size).toBe(0);
    expect(window.localStorage.getItem(SECTIONS_KEY)).toBe("[]");
  });

  it("persists collapsed subtrees separately from sections (B10)", () => {
    const { result } = renderHook(() => useCollapse());
    act(() => result.current.toggleThread("t-parent"));
    expect(result.current.collapsedThreadIds.has("t-parent")).toBe(true);
    expect(result.current.collapsedSections.size).toBe(0);
    expect(window.localStorage.getItem(THREADS_KEY)).toBe('["t-parent"]');
  });

  it.each([
    ["corrupt JSON", "{not json"],
    ["the wrong shape", '{"last-7":true}'],
    ["non-string members", "[1,2]"],
  ])("reads back nothing collapsed when the stored value is %s", (_label, stored) => {
    window.localStorage.setItem(SECTIONS_KEY, stored);
    const { result } = renderHook(() => useCollapse());
    // Falling back to "nothing collapsed" is the only failure mode that never
    // hides a thread the user has no way to get back.
    expect(result.current.collapsedSections.size).toBe(0);
  });
});
