import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchOpenCodeGoUsage,
  OPENCODE_GO_USAGE_URL,
  parseOpenCodeGoUsage,
  type FetchLike,
} from "../lib/opencode-go.ts";
import { loadUsageSnapshot, type UsageSdk } from "../lib/load-usage.ts";
import type { RawUsageResponse } from "../lib/usage.ts";

const GOOD_BODY = {
  usage: {
    rolling: {
      status: "ok",
      percent: 12.3,
      resetsAt: "2026-08-16T20:00:00.000Z",
    },
    weekly: {
      status: "ok",
      percent: 45.6,
      resetsAt: "2026-08-20T00:00:00.000Z",
    },
    monthly: { status: "ok", percent: 78.9, resetsAt: null },
  },
};

function jsonResponse(status: number, body: unknown): FetchLike {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function makeSdk(bbResponse: RawUsageResponse): UsageSdk {
  return {
    threads: {
      async get() {
        throw new Error("the strip must not resolve a thread");
      },
    },
    environments: {
      async get() {
        throw new Error("unreachable");
      },
    },
    hosts: {
      async get() {
        return { name: "Host" };
      },
    },
    system: {
      async usageLimits() {
        return bbResponse;
      },
    },
  };
}

test("exposes the documented OpenCode Go usage endpoint", () => {
  assert.equal(OPENCODE_GO_USAGE_URL, "https://opencode.ai/zen/go/v1/usage");
});

test("maps OpenCode Go windows onto canonical labels", () => {
  const usage = parseOpenCodeGoUsage(GOOD_BODY);
  assert.equal(usage.status, "ok");
  if (usage.status !== "ok") assert.fail("fixture must be healthy");
  assert.deepEqual(
    usage.windows.map((window) => [window.label, window.usedPercent]),
    [
      ["5-hour", 12.3],
      ["Weekly", 45.6],
      ["Monthly", 78.9],
    ],
  );
  assert.equal(usage.windows[0]?.resetsAt, "2026-08-16T20:00:00.000Z");
  assert.equal(usage.windows[2]?.resetsAt, null);
});

test("keeps partial OpenCode Go responses and rejects malformed ones", () => {
  const partial = parseOpenCodeGoUsage({
    usage: { weekly: { percent: 45.6, resetsAt: null } },
  });
  assert.equal(partial.status, "ok");
  if (partial.status !== "ok") assert.fail("partial fixture must be healthy");
  assert.deepEqual(
    partial.windows.map((window) => window.label),
    ["Weekly"],
  );

  assert.throws(() => parseOpenCodeGoUsage({ usage: null }), /missing/);
  assert.throws(() => parseOpenCodeGoUsage({}), /missing/);
  assert.throws(
    () => parseOpenCodeGoUsage({ usage: { weekly: { percent: "12" } } }),
    /percent/,
  );
  assert.throws(
    () => parseOpenCodeGoUsage({ usage: { weekly: { percent: 1, resetsAt: 5 } } }),
    /reset/,
  );
});

test("treats a missing key as unauthenticated without a request", async () => {
  let called = false;
  const fetchImpl: FetchLike = async () => {
    called = true;
    throw new Error("must not fetch");
  };
  assert.deepEqual(
    await fetchOpenCodeGoUsage(undefined, fetchImpl),
    { status: "unauthenticated" },
  );
  assert.deepEqual(
    await fetchOpenCodeGoUsage("   ", fetchImpl),
    { status: "unauthenticated" },
  );
  assert.equal(called, false);
});

test("fetches OpenCode Go usage with a bearer token", async () => {
  const requests: Array<{ url: string; headers?: Record<string, string> }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ url, headers: init?.headers });
    return {
      ok: true,
      status: 200,
      json: async () => GOOD_BODY,
    };
  };

  const usage = await fetchOpenCodeGoUsage("oc-key", fetchImpl);
  assert.equal(usage.status, "ok");
  assert.deepEqual(requests, [
    {
      url: OPENCODE_GO_USAGE_URL,
      headers: {
        accept: "application/json",
        authorization: "Bearer oc-key",
      },
    },
  ]);
});

test("maps OpenCode Go auth and transport failures onto provider statuses", async () => {
  assert.deepEqual(
    await fetchOpenCodeGoUsage("oc-key", jsonResponse(401, {})),
    { status: "unauthenticated" },
  );
  assert.deepEqual(
    await fetchOpenCodeGoUsage("oc-key", jsonResponse(403, {})),
    { status: "unauthenticated" },
  );
  const rateLimited = await fetchOpenCodeGoUsage(
    "oc-key",
    jsonResponse(429, {}),
  );
  assert.equal(rateLimited.status, "error");
  assert.match(
    rateLimited.status === "error" ? rateLimited.message : "",
    /rate limited/i,
  );
  const serverError = await fetchOpenCodeGoUsage(
    "oc-key",
    jsonResponse(503, {}),
  );
  assert.match(
    serverError.status === "error" ? serverError.message : "",
    /HTTP 503/,
  );
  const transport = await fetchOpenCodeGoUsage("oc-key", async () => {
    throw new Error("offline");
  });
  assert.equal(transport.status, "error");
  assert.match(
    transport.status === "error" ? transport.message : "",
    /could not be reached/,
  );
  const schema = await fetchOpenCodeGoUsage("oc-key", jsonResponse(200, {}));
  assert.match(
    schema.status === "error" ? schema.message : "",
    /unexpected/,
  );
});

test("layers the plugin-fetched provider under bb's own usage report", async () => {
  const bbResponse: RawUsageResponse = {
    codex: { status: "not_installed" },
  };
  const extra: RawUsageResponse = {
    "opencode-go": parseOpenCodeGoUsage(GOOD_BODY),
  };

  const snapshot = await loadUsageSnapshot(
    makeSdk(bbResponse),
    null,
    new Date("2026-08-11T17:00:00.000Z"),
    extra,
  );
  assert.deepEqual(
    snapshot.providers.map((provider) => provider.id),
    ["codex", "claudeCode", "cursor", "opencodeGo"],
  );
  assert.equal(snapshot.providers[0]?.status, "not_installed");
  assert.equal(snapshot.providers[3]?.status, "ok");
  if (snapshot.providers[3]?.status !== "ok") {
    assert.fail("opencode provider must be healthy");
  }
  assert.deepEqual(
    snapshot.providers[3].windows.map((window) => window.label),
    ["5-hour", "Weekly", "Monthly"],
  );
});
