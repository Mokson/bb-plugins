import { describe, expect, it, vi } from "vitest";
import type {
  PluginSidebarPullRequest,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { buildRowMenuItems } from "./row-menu-items";

/**
 * The row menu follows bb's own, read from its renderer bundle: `Columns2`
 * "Open in split", then `Mail`/`MailOpen`, `Pin`/`PinOff`, `Edit`, then a
 * separator, then `Archive` and a destructive `Trash2` "Delete".
 *
 * Pinned here because the icons drifted once already — `pin` was drawing a
 * five-pointed star, which reads as "favourite" rather than "pinned".
 */
function build(overrides: Partial<PluginSidebarThread> = {}, pr = false) {
  return buildRowMenuItems({
    thread: {
      id: "t1",
      isUnread: false,
      isPinned: false,
    } as PluginSidebarThread,
    pullRequest: pr ? ({ number: 1 } as PluginSidebarPullRequest) : null,
    isCompleted: false,
    setCompleted: () => {},
    actions: {
      setPinned: () => {},
      setRead: () => {},
      archive: () => {},
      requestDelete: () => {},
    },
    open: () => {},
    onOpenPullRequest: () => {},
    requestRename: () => {},
    ...(Object.keys(overrides).length === 0
      ? {}
      : {
          thread: {
            id: "t1",
            isUnread: false,
            isPinned: false,
            ...overrides,
          } as PluginSidebarThread,
        }),
  });
}

/** The completion item alone, with the two spies its behaviour is about. */
function completion({
  isCompleted,
  isPinned = false,
}: {
  isCompleted: boolean;
  isPinned?: boolean;
}) {
  const setCompleted = vi.fn();
  const setPinned = vi.fn();
  const items = buildRowMenuItems({
    thread: { id: "t1", isUnread: false, isPinned } as PluginSidebarThread,
    pullRequest: null,
    actions: { setPinned, setRead: () => {}, archive: () => {}, requestDelete: () => {} },
    isCompleted,
    setCompleted,
    open: () => {},
    onOpenPullRequest: () => {},
    requestRename: () => {},
  });
  return { item: items.find((entry) => entry.id === "completed")!, setCompleted, setPinned };
}

describe("row menu items", () => {
  it("orders and labels the items as bb's own menu does", () => {
    expect(build().map((item) => [item.label, item.glyph])).toEqual([
      ["Open", "external-link"],
      ["Open in split", "split"],
      ["Mark unread", "mail-open"],
      ["Pin", "pin"],
      ["Rename", "pencil"],
      ["Mark completed", "check"],
      ["Archive", "archive"],
      ["Delete", "trash"],
    ]);
  });

  it("flips the read and pin items with their state, as bb does", () => {
    const unread = build({ isUnread: true });
    expect(unread.find((i) => i.id === "read")).toMatchObject({
      label: "Mark read",
      glyph: "mail",
    });

    const pinned = build({ isPinned: true });
    expect(pinned.find((i) => i.id === "pin")).toMatchObject({
      label: "Unpin",
      glyph: "pin-off",
    });
  });

  it("groups with separators where bb groups", () => {
    const separated = build()
      .filter((item) => item.separatorBefore)
      .map((item) => item.id);
    expect(separated).toEqual(["read", "completed"]);
  });

  it("flips the completion item with its state (B86)", () => {
    const active = completion({ isCompleted: false });
    expect(active.item).toMatchObject({ label: "Mark completed", glyph: "check" });
    active.item.onSelect();
    expect(active.setCompleted).toHaveBeenCalledWith("t1", true);

    const done = completion({ isCompleted: true });
    expect(done.item).toMatchObject({ label: "Mark active", glyph: "circle-x" });
    done.item.onSelect();
    expect(done.setCompleted).toHaveBeenCalledWith("t1", false);
  });

  it("clears the pin when a pinned thread is filed, so no thread claims two bands", () => {
    const filed = completion({ isCompleted: false, isPinned: true });
    filed.item.onSelect();
    expect(filed.setPinned).toHaveBeenCalledWith("t1", false);
  });

  it("leaves the pin alone when a filed thread is put BACK", () => {
    const restored = completion({ isCompleted: true, isPinned: true });
    restored.item.onSelect();
    expect(restored.setPinned).not.toHaveBeenCalled();
  });

  it("adds the pull-request item only when the branch has one", () => {
    expect(build({}, true).map((i) => i.id)).toContain("open-pr");
    expect(build().map((i) => i.id)).not.toContain("open-pr");
  });

  it("marks only delete destructive", () => {
    expect(build().filter((i) => i.destructive).map((i) => i.id)).toEqual([
      "delete",
    ]);
  });
});
