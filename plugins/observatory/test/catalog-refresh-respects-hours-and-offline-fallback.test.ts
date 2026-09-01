import { afterEach, describe, expect, it, vi } from "vitest";
import { bundledCatalog, loadCatalog, MODELS_DEV_URL } from "../src/core/catalog.js";
import { TempDatabase } from "./fakes.js";

const databases: TempDatabase[] = [];
function freshDatabase() {
  const temp = new TempDatabase();
  databases.push(temp);
  return temp.openDatabase();
}
afterEach(() => {
  while (databases.length) databases.pop()!.dispose();
});

const REMOTE = {
  anthropic: {
    models: {
      "claude-opus-5": { cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 } },
    },
  },
};

// `text`, not `json`: the loader reads the body as text so it can refuse one
// that is too large before parsing it.
function fakeFetch(body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(
    async (url: string | URL | Request, _init?: RequestInit) =>
      ({
        ok: true,
        text: async () => JSON.stringify(body),
        headers: new Headers(headers),
        url: String(url),
      }) as unknown as Response,
  );
}

// A cost page that blocks on a third-party HTTP call is a cost page that
// hangs, and a machine with no network still has to price yesterday's runs.
describe("the pricing catalog", () => {
  it("fetches once and then serves the cached row inside the refresh window", async () => {
    const db = freshDatabase();
    const fetchImpl = fakeFetch(REMOTE);
    let now = Date.parse("2026-09-01T00:00:00.000Z");

    const first = await loadCatalog(db, { refreshHours: 24, fetch: fetchImpl, now: () => now });
    now += 60 * 60 * 1000;
    const second = await loadCatalog(db, { refreshHours: 24, fetch: fetchImpl, now: () => now });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe(MODELS_DEV_URL);
    expect(second.revision).toBe(first.revision);
    expect(second.providers.anthropic!["claude-opus-5"]!.input).toBe(5);
  });

  it("refetches once the row is older than the window", async () => {
    const db = freshDatabase();
    const fetchImpl = fakeFetch(REMOTE);
    let now = Date.parse("2026-09-01T00:00:00.000Z");

    await loadCatalog(db, { refreshHours: 24, fetch: fetchImpl, now: () => now });
    now += 25 * 60 * 60 * 1000;
    await loadCatalog(db, { refreshHours: 24, fetch: fetchImpl, now: () => now });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("serves the last good row when the fetch fails", async () => {
    const db = freshDatabase();
    let now = Date.parse("2026-09-01T00:00:00.000Z");
    await loadCatalog(db, { refreshHours: 24, fetch: fakeFetch(REMOTE), now: () => now });

    now += 25 * 60 * 60 * 1000;
    const offline = await loadCatalog(db, {
      refreshHours: 24,
      fetch: vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND models.dev");
      }),
      now: () => now,
    });

    expect(offline.providers.anthropic!["claude-opus-5"]!.input).toBe(5);
  });

  it("falls back to the bundled snapshot with no row and no network", async () => {
    const db = freshDatabase();

    const catalog = await loadCatalog(db, {
      refreshHours: 24,
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }),
    });

    expect(catalog.revision).toBe(bundledCatalog().revision);
    expect(Object.keys(catalog.providers).length).toBeGreaterThan(20);
  });

  it("never touches the network when no fetch is supplied", async () => {
    const db = freshDatabase();

    const catalog = await loadCatalog(db, { refreshHours: 24 });

    expect(catalog.revision).toBe(bundledCatalog().revision);
  });
});
