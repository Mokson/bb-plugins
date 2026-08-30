// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import {
  installTestPluginRuntime,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";

installTestPluginRuntime();

const { useThreadExecutions, resetThreadExecutionsCache } = await import(
  "./useThreadExecutions"
);
const { betterSidebarRpcContract } = await import("../server-contract");

type Contract = typeof betterSidebarRpcContract;

function Harness({
  threadIds,
  enabled,
}: {
  threadIds: string[];
  enabled: boolean;
}) {
  const state = useThreadExecutions(threadIds, enabled);
  return (
    <div>
      <span data-testid="status">{state.status}</span>
      <span data-testid="models">
        {threadIds
          .map((id) => state.executions.get(id)?.model ?? "-")
          .join(",")}
      </span>
    </div>
  );
}

function handlers(
  overrides: Partial<PluginRpcTestHandlers<Contract>> = {},
): PluginRpcTestHandlers<Contract> {
  return {
    threadDossier: () => {
      throw new Error("unused");
    },
    rowSignals: () => ({ signals: [] }),
    threadExecutions: ({ threadIds }) => ({
      executions: threadIds.map((threadId) => ({
        threadId,
        execution: { model: `model-${threadId}`, reasoningLevel: "high" },
      })),
    }),
    lastActivity: () => ({ activity: [] }),
    ...overrides,
  };
}

function render(
  props: { threadIds: string[]; enabled: boolean },
  rpc: Partial<PluginRpcTestHandlers<Contract>> = {},
) {
  return renderSlot<{ threadIds: string[]; enabled: boolean }, Contract>(
    { component: Harness },
    props,
    { rpc: handlers(rpc) },
  );
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const status = () => screen.getByTestId("status").textContent;
const models = () => screen.getByTestId("models").textContent;
const calls = (slot: { inspection: { rpcCalls: { method: string }[] } }) =>
  slot.inspection.rpcCalls.filter((call) => call.method === "threadExecutions");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  resetThreadExecutionsCache();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useThreadExecutions gating (B71.2)", () => {
  it("stays idle and issues no call while disabled", async () => {
    const slot = render({ threadIds: ["a", "b"], enabled: false });
    await settle();
    expect(status()).toBe("idle");
    expect(calls(slot)).toHaveLength(0);
  });
});

describe("useThreadExecutions batching (B71.1)", () => {
  it("covers every id in one request", async () => {
    const ids = Array.from({ length: 17 }, (_, i) => `t${i}`);
    const slot = render({ threadIds: ids, enabled: true });
    expect(status()).toBe("loading");
    await settle();

    expect(status()).toBe("ready");
    expect(calls(slot)).toHaveLength(1);
    expect(calls(slot)[0]).toMatchObject({ input: { threadIds: ids } });
  });

  it("treats an id the backend omitted as resolved with no execution", async () => {
    render({ threadIds: ["a", "b"], enabled: true }, {
      threadExecutions: () => ({
        executions: [{ threadId: "a", execution: null }],
      }),
    });
    await settle();
    expect(status()).toBe("ready");
    expect(models()).toBe("-,-");
  });
});

describe("useThreadExecutions caching (B71.4)", () => {
  it("re-enabling inside the READY TTL issues no second request", async () => {
    const slot = render({ threadIds: ["a"], enabled: true });
    await settle();
    expect(calls(slot)).toHaveLength(1);

    slot.lifecycle.rerender(<Harness threadIds={["a"]} enabled={false} />);
    slot.lifecycle.rerender(<Harness threadIds={["a"]} enabled={true} />);
    await settle();

    expect(calls(slot)).toHaveLength(1);
    expect(models()).toBe("model-a");
  });

  it("re-requests once the READY TTL has passed", async () => {
    const slot = render({ threadIds: ["a"], enabled: true });
    await settle();
    expect(calls(slot)).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    slot.lifecycle.rerender(<Harness threadIds={["a"]} enabled={true} />);
    await settle();

    expect(calls(slot)).toHaveLength(2);
  });

  it("asks only for the ids it does not already hold", async () => {
    const slot = render({ threadIds: ["a"], enabled: true });
    await settle();

    slot.lifecycle.rerender(<Harness threadIds={["a", "b"]} enabled={true} />);
    await settle();

    expect(calls(slot)).toHaveLength(2);
    expect(calls(slot)[1]).toMatchObject({ input: { threadIds: ["b"] } });
    expect(models()).toBe("model-a,model-b");
  });
});

describe("useThreadExecutions rejection (B71.3)", () => {
  it("settles in error rather than spinning, and caches the rejection", async () => {
    const slot = render({ threadIds: ["a"], enabled: true }, {
      threadExecutions: () => {
        throw new Error("backend unavailable");
      },
    });
    await settle();

    expect(status()).toBe("error");
    expect(models()).toBe("-");
    expect(calls(slot)).toHaveLength(1);

    slot.lifecycle.rerender(<Harness threadIds={["a"]} enabled={true} />);
    await settle();
    // The 2s error TTL absorbs the re-render; a retry storm would show here.
    expect(calls(slot)).toHaveLength(1);
  });
});
