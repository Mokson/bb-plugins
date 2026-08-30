// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useGroupBy } from "./useGroupBy";

const KEY = "better-sidebar:group-by";

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe("useGroupBy (B77)", () => {
  it("falls back to the setting when nothing is stored (B77.3)", () => {
    const { result } = renderHook(() => useGroupBy("host"));
    expect(result.current.groupBy).toBe("host");
    expect(window.localStorage.length).toBe(0);
  });

  it("prefers the stored value over the setting (B77.3)", () => {
    window.localStorage.setItem(KEY, JSON.stringify("status"));
    const { result } = renderHook(() => useGroupBy("host"));
    expect(result.current.groupBy).toBe("status");
  });

  it("persists a choice, so the next mount reads it back (B77.2)", () => {
    const { result } = renderHook(() => useGroupBy("date"));
    act(() => result.current.setGroupBy("project"));
    expect(result.current.groupBy).toBe("project");
    expect(window.localStorage.getItem(KEY)).toBe(JSON.stringify("project"));

    cleanup();
    expect(renderHook(() => useGroupBy("date")).result.current.groupBy).toBe("project");
  });

  it.each(['"bogus"', "42", "not json", "null"])(
    "falls back to the setting when the store holds %s (B77.4)",
    (stored) => {
      window.localStorage.setItem(KEY, stored);
      expect(renderHook(() => useGroupBy("host")).result.current.groupBy).toBe("host");
    },
  );

  it("keeps working when localStorage throws", () => {
    const getItem = window.Storage.prototype.getItem;
    window.Storage.prototype.getItem = () => {
      throw new Error("disabled");
    };
    try {
      expect(renderHook(() => useGroupBy("none")).result.current.groupBy).toBe("none");
    } finally {
      window.Storage.prototype.getItem = getItem;
    }
  });
});
