// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type {
  PluginSidebarPullRequest,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk";
import type { RenameEditor } from "./useRenameEditor";

// The `@get-bb/plugin-sdk/app` shim binds its exports at module load, so the
// test runtime has to be installed before the component is imported.
installTestPluginRuntime();
const { RowContextMenu } = await import("./RowContextMenu");

function thread(overrides: Partial<PluginSidebarThread> = {}) {
  return {
    id: "thr_1",
    projectId: "proj_1",
    title: "Right click me",
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "codex",
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
    createdAt: 100,
    updatedAt: 100,
    lastReadAt: 100,
    latestAttentionAt: 100,
    ...overrides,
  } satisfies PluginSidebarThread;
}

const pullRequest: PluginSidebarPullRequest = {
  number: 7,
  title: "Add the sidebar",
  url: "https://example.test/pr/7",
  state: "open",
  attention: "none",
};

function renameEditor(start = vi.fn()): RenameEditor {
  return {
    isRenaming: false,
    inputProps: {
      value: "",
      autoFocus: true,
      "aria-label": "Rename thread",
      onChange: () => {},
      onKeyDown: () => {},
      onBlur: () => {},
    },
    start,
    cancel: vi.fn(),
  };
}

function open(
  props: Partial<Parameters<typeof RowContextMenu>[0]> = {},
  options: Parameters<typeof renderSlot>[2] = {},
) {
  const rendered = renderSlot(
    { component: RowContextMenu },
    {
      thread: thread(),
      pullRequest: null,
      onNavigate: vi.fn(),
      renameEditor: renameEditor(),
      children: <div>Right click me</div>,
      ...props,
    },
    options,
  );
  fireEvent.contextMenu(screen.getByText("Right click me"));
  return rendered;
}

function menu() {
  return screen.getByRole("menu", { name: "Thread actions" });
}

function click(label: string) {
  fireEvent.click(within(menu()).getByText(label));
}

afterEach(cleanup);

describe("RowContextMenu", () => {
  it("marks the portalled content as a plugin overlay", () => {
    open();
    // Without this the host's outside-click logic dismisses the menu and the
    // theme custom properties do not resolve (§9).
    expect(menu().getAttribute("data-bb-portaled-overlay")).toBe("");
    expect(menu().getAttribute("data-bb-plugin-root")).toBe("");
  });

  it("offers all eight items, with no pull-request item when there is none", () => {
    open();
    expect(
      within(menu())
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Open",
      "Open in split",
      "Pin",
      "Mark unread",
      "Rename",
      "Archive",
      "Delete…",
    ]);
  });

  it("offers no silent delete path — only the host's confirmation", () => {
    const rendered = open();
    click("Delete…");
    expect(rendered.inspection.sidebarActionCalls).toEqual([
      { method: "requestDelete", threadId: "thr_1" },
    ]);
    expect(
      rendered.inspection.sidebarActionCalls.some(
        (call) => (call.method as string) === "delete",
      ),
    ).toBe(false);
  });

  it("opens the thread and then navigates", () => {
    const onNavigate = vi.fn();
    const rendered = open({ onNavigate });
    click("Open");
    expect(rendered.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "thr_1" },
    ]);
    // `actions.open` takes no callback, so the menu must close the mobile
    // drawer and release the host search field itself (B47).
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("opens in split and then navigates", () => {
    const onNavigate = vi.fn();
    const rendered = open({ onNavigate });
    click("Open in split");
    expect(rendered.inspection.sidebarActionCalls).toEqual([
      { method: "open", threadId: "thr_1", options: { split: true } },
    ]);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("pins an unpinned thread and unpins a pinned one", () => {
    const pinning = open();
    click("Pin");
    expect(pinning.inspection.sidebarActionCalls).toEqual([
      { method: "setPinned", threadId: "thr_1", pinned: true },
    ]);
    cleanup();

    const unpinning = open({ thread: thread({ isPinned: true }) });
    click("Unpin");
    expect(unpinning.inspection.sidebarActionCalls).toEqual([
      { method: "setPinned", threadId: "thr_1", pinned: false },
    ]);
  });

  it("marks a read thread unread and an unread thread read", () => {
    const marking = open();
    click("Mark unread");
    expect(marking.inspection.sidebarActionCalls).toEqual([
      { method: "setRead", threadId: "thr_1", read: false },
    ]);
    cleanup();

    const clearing = open({ thread: thread({ isUnread: true }) });
    click("Mark read");
    expect(clearing.inspection.sidebarActionCalls).toEqual([
      { method: "setRead", threadId: "thr_1", read: true },
    ]);
  });

  it("archives through the host, which archives children too", () => {
    const rendered = open();
    click("Archive");
    expect(rendered.inspection.sidebarActionCalls).toEqual([
      { method: "archive", threadId: "thr_1" },
    ]);
  });

  it("starts the inline editor for rename and never renames directly", () => {
    const start = vi.fn();
    const rendered = open({ renameEditor: renameEditor(start) });
    click("Rename");
    // `actions.rename` is silent and needs a finished title, so the menu opens
    // the row's editor instead of acting.
    expect(start).toHaveBeenCalledWith("Right click me");
    expect(rendered.inspection.sidebarActionCalls).toEqual([]);
  });

  it("shows the pull-request item only when a pull request is passed", () => {
    const openUrl = vi.fn(() => true);
    open({ pullRequest }, { openUrl });
    expect(
      within(menu())
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toContain("Open pull request");

    click("Open pull request");
    expect(openUrl).toHaveBeenCalledWith("https://example.test/pr/7");
  });
});
