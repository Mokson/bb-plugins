// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import {
  installTestPluginRuntime,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@get-bb/plugin-sdk/testing/app";

installTestPluginRuntime();

const { useDossier, resetDossierCache } = await import("./useDossier");
const { betterSidebarRpcContract, DOSSIER_CHANNEL } = await import(
  "../server-contract"
);

type Contract = typeof betterSidebarRpcContract;

function dossier(threadId: string) {
  return {
    threadId,
    execution: { model: "claude-opus-5", reasoningLevel: "high" },
    economics: null,
    contextWindow: null,
    fetchedAt: 0,
  };
}

function Harness({ threadId, enabled }: { threadId: string; enabled: boolean }) {
  const state = useDossier(threadId, enabled);
  return (
    <div>
      <span data-testid="status">{state.status}</span>
      <span data-testid="model">{state.data?.execution?.model ?? ""}</span>
      <span data-testid="error">{state.error ?? ""}</span>
      <button type="button" onClick={state.retry}>
        retry
      </button>
    </div>
  );
}

function render(
  props: { threadId: string; enabled: boolean },
  rpc: Partial<PluginRpcTestHandlers<Contract>> = {},
) {
  return renderSlot<{ threadId: string; enabled: boolean }, Contract>(
    { component: Harness },
    props,
    {
      rpc: {
        threadDossier: ({ threadId }) => dossier(threadId),
        rowSignals: () => ({ signals: [] }),
        threadExecutions: () => ({ executions: [] }),
        lastActivity: () => ({ activity: [] }),
        ...rpc,
      },
    },
  );
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

const status = () => screen.getByTestId("status").textContent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  resetDossierCache();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useDossier status machine", () => {
  it("stays idle and issues no call until it is enabled", async () => {
    const slot = render({ threadId: "t1", enabled: false });
    await settle();
    expect(status()).toBe("idle");
    expect(slot.inspection.rpcCalls).toHaveLength(0);
  });

  it("goes loading then ready", async () => {
    render({ threadId: "t1", enabled: true });
    expect(status()).toBe("loading");
    await settle();
    expect(status()).toBe("ready");
    expect(screen.getByTestId("model").textContent).toBe("claude-opus-5");
  });
});

describe("useDossier rejection branch (§5 DossierState)", () => {
  it("retries once, ends in error with a message, and never spins forever", async () => {
    const slot = render({ threadId: "t1", enabled: true }, {
      threadDossier: () => {
        throw new Error("backend unavailable");
      },
    });
    await settle();

    expect(status()).toBe("error");
    expect(screen.getByTestId("error").textContent).toBe("backend unavailable");
    // The call plus exactly one automatic retry — not one per re-render.
    expect(slot.inspection.rpcCalls).toHaveLength(2);
  });

  it("caches the rejection, so a second hook inside 2s adds no call", async () => {
    const slot = render({ threadId: "t1", enabled: true }, {
      threadDossier: () => {
        throw new Error("backend unavailable");
      },
    });
    await settle();
    expect(slot.inspection.rpcCalls).toHaveLength(2);

    slot.lifecycle.rerender(<Harness threadId="t1" enabled={true} />);
    await settle();
    expect(slot.inspection.rpcCalls).toHaveLength(2);
  });

  it("retry() clears the cached rejection and calls again", async () => {
    let fail = true;
    const slot = render({ threadId: "t1", enabled: true }, {
      threadDossier: ({ threadId }) => {
        if (fail) throw new Error("backend unavailable");
        return dossier(threadId);
      },
    });
    await settle();
    expect(status()).toBe("error");

    fail = false;
    await act(async () => {
      screen.getByText("retry").click();
    });
    await settle();
    expect(status()).toBe("ready");
    expect(slot.inspection.rpcCalls).toHaveLength(3);
  });
});

describe("useDossier cache (B27, B28)", () => {
  it("re-enabling inside the 10s TTL renders ready on the first paint", async () => {
    const slot = render({ threadId: "t1", enabled: true });
    await settle();
    expect(slot.inspection.rpcCalls).toHaveLength(1);

    slot.lifecycle.rerender(<Harness threadId="t1" enabled={false} />);
    await act(async () => {
      vi.advanceTimersByTime(9_000);
    });
    slot.lifecycle.rerender(<Harness threadId="t1" enabled={true} />);

    // No settle: the very first paint after re-enabling is already populated.
    expect(status()).toBe("ready");
    expect(slot.inspection.rpcCalls).toHaveLength(1);
  });

  it("refetches once the TTL has expired and the popover re-opens", async () => {
    const slot = render({ threadId: "t1", enabled: true });
    await settle();

    slot.lifecycle.rerender(<Harness threadId="t1" enabled={false} />);
    await act(async () => {
      vi.advanceTimersByTime(11_000);
    });
    slot.lifecycle.rerender(<Harness threadId="t1" enabled={true} />);
    await settle();
    expect(slot.inspection.rpcCalls).toHaveLength(2);
  });

  /**
   * The motivating scenario, which the disable-then-advance ordering above is
   * the one arrangement that hides. A dossier that ages past its TTL **while
   * the popover is still open** used to re-evaluate to `loading` on the next
   * re-render — `useNow`'s minute tick is enough — and nothing re-triggered
   * the fetch, because the effect's deps had not changed. The card was stuck
   * on a skeleton it could never leave.
   */
  it("keeps serving its settled value past the TTL while the popover stays open, and refetches", async () => {
    const slot = render({ threadId: "t1", enabled: true });
    await settle();
    expect(status()).toBe("ready");
    expect(slot.inspection.rpcCalls).toHaveLength(1);

    // Only the clock moves. `enabled` never goes false: the pointer has not
    // left the row.
    await act(async () => {
      vi.advanceTimersByTime(11_000);
    });
    slot.lifecycle.rerender(<Harness threadId="t1" enabled={true} />);
    expect(status()).toBe("ready");
    expect(screen.getByTestId("model").textContent).toBe("claude-opus-5");

    await settle();
    expect(status()).toBe("ready");
    expect(slot.inspection.rpcCalls).toHaveLength(2);
  });

  it("drops the entry when the backend publishes on the dossier channel (B28)", async () => {
    const slot = render({ threadId: "t1", enabled: true });
    await settle();
    expect(slot.inspection.rpcCalls).toHaveLength(1);

    await slot.behavior.emitRealtime(DOSSIER_CHANNEL, { threadId: "t1" });
    await settle();
    expect(slot.inspection.rpcCalls).toHaveLength(2);
    expect(status()).toBe("ready");
  });
});
