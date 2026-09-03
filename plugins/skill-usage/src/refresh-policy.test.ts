import { describe, expect, it } from "vitest";
import { REFRESH_COOLDOWN_MS, shouldRefresh } from "./refresh-policy";

const NOW = 1_000_000;

describe("shouldRefresh", () => {
  it("refreshes when the index has never been built", () => {
    expect(shouldRefresh({ running: false, lastRefreshAt: null, nowMs: NOW, rebuild: false })).toBe(
      true,
    );
  });

  it("skips a pass inside the cooldown, so switching scopes is free", () => {
    expect(
      shouldRefresh({
        running: false,
        lastRefreshAt: NOW - (REFRESH_COOLDOWN_MS - 1),
        nowMs: NOW,
        rebuild: false,
      }),
    ).toBe(false);
  });

  it("refreshes once the cooldown has elapsed", () => {
    expect(
      shouldRefresh({
        running: false,
        lastRefreshAt: NOW - REFRESH_COOLDOWN_MS,
        nowMs: NOW,
        rebuild: false,
      }),
    ).toBe(true);
  });

  it("lets an explicit rebuild ignore the cooldown", () => {
    expect(
      shouldRefresh({ running: false, lastRefreshAt: NOW - 1, nowMs: NOW, rebuild: true }),
    ).toBe(true);
  });

  it("never starts a second pass while one runs, rebuild included", () => {
    expect(shouldRefresh({ running: true, lastRefreshAt: null, nowMs: NOW, rebuild: false })).toBe(
      false,
    );
    expect(shouldRefresh({ running: true, lastRefreshAt: null, nowMs: NOW, rebuild: true })).toBe(
      false,
    );
  });
});
