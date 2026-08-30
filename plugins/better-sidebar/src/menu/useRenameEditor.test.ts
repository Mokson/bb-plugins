// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";

// The `@get-bb/plugin-sdk/app` shim binds its exports at module load, so the
// test runtime has to be installed before the hook module is imported.
installTestPluginRuntime();
const { useRenameEditor } = await import("./useRenameEditor");

/** Renders the editor the way slice 3's `ThreadRow` does. */
function Harness({
  threadId,
  initialTitle,
}: {
  threadId: string;
  initialTitle: string;
}) {
  const editor = useRenameEditor(threadId);
  return createElement(
    "div",
    null,
    editor.isRenaming
      ? createElement("input", editor.inputProps)
      : createElement(
          "button",
          { onClick: () => editor.start(initialTitle) },
          "Rename",
        ),
  );
}

function render(initialTitle = "Original title") {
  const rendered = renderSlot(
    { component: Harness },
    { threadId: "thr_1", initialTitle },
  );
  fireEvent.click(screen.getByText("Rename"));
  return rendered;
}

function type(value: string) {
  fireEvent.change(screen.getByLabelText("Rename thread"), { target: { value } });
}

afterEach(cleanup);

describe("useRenameEditor", () => {
  it("opens the inline editor seeded with the current title", () => {
    render();
    expect(
      (screen.getByLabelText("Rename thread") as HTMLInputElement).value,
    ).toBe("Original title");
  });

  it("commits the typed title on Enter", () => {
    const rendered = render();
    type("New title");
    fireEvent.keyDown(screen.getByLabelText("Rename thread"), { key: "Enter" });

    expect(rendered.inspection.sidebarActionCalls).toEqual([
      { method: "rename", threadId: "thr_1", title: "New title" },
    ]);
    expect(screen.getByText("Rename")).toBeDefined();
  });

  it("commits on blur", () => {
    const rendered = render();
    type("Blurred title");
    fireEvent.blur(screen.getByLabelText("Rename thread"));

    expect(rendered.inspection.sidebarActionCalls).toEqual([
      { method: "rename", threadId: "thr_1", title: "Blurred title" },
    ]);
  });

  it("leaves the action log empty on Escape, including the blur that follows", () => {
    const rendered = render();
    const input = screen.getByLabelText("Rename thread");
    type("Discarded title");
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);

    expect(rendered.inspection.sidebarActionCalls).toEqual([]);
    expect(screen.getByText("Rename")).toBeDefined();
  });

  it("does not rename an unchanged title", () => {
    const rendered = render();
    fireEvent.keyDown(screen.getByLabelText("Rename thread"), { key: "Enter" });
    expect(rendered.inspection.sidebarActionCalls).toEqual([]);
  });

  it("does not rename to an empty or whitespace-only title", () => {
    const rendered = render();
    type("   ");
    fireEvent.keyDown(screen.getByLabelText("Rename thread"), { key: "Enter" });
    expect(rendered.inspection.sidebarActionCalls).toEqual([]);
  });
});
