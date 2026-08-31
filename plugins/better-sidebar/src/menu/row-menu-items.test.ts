import { describe, expect, it } from "vitest";
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

describe("row menu items", () => {
  it("orders and labels the items as bb's own menu does", () => {
    expect(build().map((item) => [item.label, item.glyph])).toEqual([
      ["Open", "external-link"],
      ["Open in split", "split"],
      ["Mark unread", "mail-open"],
      ["Pin", "pin"],
      ["Rename", "pencil"],
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
    expect(separated).toEqual(["read", "archive"]);
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
