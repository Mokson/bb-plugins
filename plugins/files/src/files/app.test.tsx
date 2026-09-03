// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import "./../test-setup";

installTestPluginRuntime();

const app = await loadPluginApp(() => import("../../app"));

beforeEach(() => {
  // Selection and width persist in localStorage: clear between tests so one
  // opened file cannot leak into the next panel mount.
  localStorage.clear();
});

const treeRpc = {
  tree: () => ({
    root: "/root",
    entries: [
      { path: "src/app.ts", kind: "file" },
      { path: "src", kind: "directory" },
      { path: "logo.png", kind: "file" },
      { path: "notes.md", kind: "file" },
    ],
    truncated: false,
  }),
};

function readStub(input: unknown) {
  const path =
    typeof input === "object" && input !== null && "path" in input && typeof input.path === "string"
      ? input.path
      : "";
  if (path.endsWith(".md")) {
    return {
      path,
      content: "# Release notes\n\nShips today.",
      sha256: "md5",
      sizeBytes: 30,
      truncated: false,
    };
  }
  return {
    path,
    content: "const a = 1;",
    sha256: "abc",
    sizeBytes: 12,
    truncated: false,
  };
}

describe("files panel", () => {
  it("fills the tab height", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "t1", params: null },
      { rpc: { ...treeRpc } },
    );
    await slot.findByText("app.ts");
    const root = slot.container.firstElementChild;
    expect(root?.className).toMatch(/(^|\s)h-full(\s|$)/);
    slot.lifecycle.unmount();
  });

  it("renders the explorer over rpc tree data", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "t1", params: null },
      { rpc: { ...treeRpc } },
    );
    await slot.findByText("app.ts");
    slot.lifecycle.unmount();
  });

  it("opens a file and renders its content", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "t1", params: null },
      {
        rpc: {
          ...treeRpc,
          read: readStub,
        },
      },
    );
    const row = await slot.findByText("app.ts");
    row.click();
    await slot.findByText("src/app.ts", { selector: "span[title]" });
    slot.lifecycle.unmount();
  });

  it("renders markdown by default with a source toggle", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "t1", params: null },
      {
        rpc: {
          ...treeRpc,
          read: readStub,
        },
      },
    );
    const row = await slot.findByText("notes.md");
    row.click();
    const rendered = await slot.findByTestId("bb-markdown");
    expect(rendered.textContent).toContain("Release notes");
    const toggle = await slot.findByLabelText("Show markdown source");
    toggle.click();
    await slot.findByLabelText("Edit notes.md");
    slot.lifecycle.unmount();
  });

  it("restores the opened file after a remount", async () => {
    const first = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "persist-t1", params: null },
      {
        rpc: {
          ...treeRpc,
          read: readStub,
        },
      },
    );
    const row = await first.findByText("app.ts");
    row.click();
    await first.findByText("src/app.ts", { selector: "span[title]" });
    first.lifecycle.unmount();

    const second = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "persist-t1", params: null },
      {
        rpc: {
          ...treeRpc,
          read: readStub,
        },
      },
    );
    await second.findByText("src/app.ts", { selector: "span[title]" });
    second.lifecycle.unmount();
  });

  it("filters the tree as the user searches", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "t1", params: null },
      { rpc: { ...treeRpc } },
    );
    await slot.findByText("app.ts");
    const search = await slot.findByLabelText("Search files");
    fireEvent.change(search, { target: { value: "logo" } });
    await slot.findByText("logo.png");
    expect(slot.queryByText("app.ts")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("renders images through the media rpc", async () => {    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "t1", params: null },
      {
        rpc: {
          ...treeRpc,
          media: () => ({
            available: true,
            imageUrl: "https://preview.test/p/logo.png",
            sizeBytes: null,
          }),
        },
      },
    );
    const row = await slot.findByText("logo.png");
    row.click();
    await slot.findByAltText("logo.png");
    slot.lifecycle.unmount();
  });

  it("starts a mention drag from file and folder labels", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "t1", params: null },
      { rpc: { ...treeRpc } },
    );
    const folderLabel = await slot.findByTitle("src");
    const fileCandidates = await slot.findAllByTitle("src/app.ts");
    const fileLabel = fileCandidates.find((el) => el.nodeName === "BUTTON");
    expect(fileLabel).toBeDefined();
    for (const label of [folderLabel, fileLabel!]) {
      const setData = vi.fn();
      fireEvent.dragStart(label, { dataTransfer: { setData } });
      expect(setData).toHaveBeenCalledWith(
        "text/plain",
        `@${label.getAttribute("title")} `,
      );
    }
    slot.lifecycle.unmount();
  });
});
