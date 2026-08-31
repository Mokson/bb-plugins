import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBatchCache } from "./batch-cache";

interface Result {
  values: { threadId: string; value: string }[];
}

function makeCache() {
  return createBatchCache<string | null, Result, "probe">({
    method: "probe",
    readyTtlMs: 10_000,
    errorTtlMs: 2_000,
    maxIdsPerRequest: 60,
    unpack: (result) => new Map(result.values.map((row) => [row.threadId, row.value])),
    missing: null,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("batch-cache", () => {
  it("keeps serving a settled value past the TTL, and refetches once", async () => {
    const cache = makeCache();
    const call = vi
      .fn()
      .mockResolvedValue({ values: [{ threadId: "t1", value: "first" }] } satisfies Result);

    cache.ensure(["t1"], call);
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.get("t1")?.value).toBe("first");

    await vi.advanceTimersByTimeAsync(11_000);
    // The row draws the last known value while the refresh is in flight;
    // dropping it here is the flicker this cache exists to avoid.
    expect(cache.get("t1")?.value).toBe("first");

    cache.ensure(["t1"], call);
    expect(call).toHaveBeenCalledTimes(2);
    // A second render inside the same round trip does not issue a third call.
    cache.ensure(["t1"], call);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("keeps the last known value when a batch rejects", async () => {
    const cache = makeCache();
    const ok = vi.fn().mockResolvedValue({ values: [{ threadId: "t1", value: "first" }] });
    cache.ensure(["t1"], ok);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(11_000);
    const failing = vi.fn().mockRejectedValue(new Error("backend down"));
    cache.ensure(["t1"], failing);
    await vi.advanceTimersByTimeAsync(0);

    const entry = cache.get("t1");
    expect(entry?.failed).toBe(true);
    expect(entry?.value).toBe("first");
  });

  it("resolves an id the backend omitted to the missing value", async () => {
    const cache = makeCache();
    cache.ensure(["t1"], vi.fn().mockResolvedValue({ values: [] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.get("t1")).toEqual({ value: null, failed: false, expiresAt: expect.any(Number) });
  });
});
