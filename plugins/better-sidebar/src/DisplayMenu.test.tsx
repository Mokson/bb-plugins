// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import { ALL_PROJECTS, DisplayMenu } from "./DisplayMenu";
import type { GroupBy } from "./model/types";

const PROJECTS: PluginSidebarProject[] = [
  { id: "p1", name: "bb-plugins", isPersonal: false },
  { id: "p2", name: "Beta", isPersonal: false },
];

afterEach(cleanup);

/**
 * B79.6. The menu has two shapes and one behaviour set, so the suite runs
 * twice: nested submenus at a wide viewport, one flat menu at a compact one.
 * `isCompactViewport` threads through every helper, and only the two
 * shape-specific tests read it directly.
 */
const SHAPES = [
  { name: "nested (wide)", isCompactViewport: false },
  { name: "flat (compact)", isCompactViewport: true },
] as const;

function renderMenu(
  isCompactViewport: boolean,
  overrides: {
    projects?: PluginSidebarProject[];
    projectFilter?: string;
    groupBy?: GroupBy;
    onProjectFilterChange?: (value: string) => void;
    onGroupByChange?: (value: GroupBy) => void;
  } = {},
) {
  return render(
    <DisplayMenu
      projects={overrides.projects ?? PROJECTS}
      projectFilter={overrides.projectFilter ?? ALL_PROJECTS}
      onProjectFilterChange={overrides.onProjectFilterChange ?? (() => {})}
      groupBy={overrides.groupBy ?? "date"}
      onGroupByChange={overrides.onGroupByChange ?? (() => {})}
      isCompactViewport={isCompactViewport}
    />,
  );
}

/** Radix opens a dropdown from the keyboard with no pointer shims in jsdom. */
function openMenu(isCompactViewport: boolean) {
  // Most cases want the default props, so opening implies the default render.
  if (screen.queryByLabelText("Display options") === null) renderMenu(isCompactViewport);
  fireEvent.keyDown(screen.getByLabelText("Display options"), { key: "Enter" });
}

/**
 * The element holding one label's radio items: a submenu in the nested shape,
 * a labelled group in the flat one.
 */
function section(isCompactViewport: boolean, label: string): HTMLElement {
  openMenu(isCompactViewport);
  if (isCompactViewport) return screen.getByRole("group", { name: label });
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
  return screen.getByRole("menu", { name: label });
}

function itemLabels(node: HTMLElement): string[] {
  return Array.from(node.querySelectorAll('[role="menuitemradio"]')).map(
    (item) => item.textContent?.trim() ?? "",
  );
}

function checkedLabels(node: HTMLElement): (string | undefined)[] {
  return Array.from(node.querySelectorAll('[aria-checked="true"]')).map((item) =>
    item.textContent?.trim(),
  );
}

describe("DisplayMenu — the row and its trigger (B76)", () => {
  it("is the trigger alone with no scope active (B76.3)", () => {
    const { container } = renderMenu(false);
    expect(screen.getByLabelText("Display options")).toBeTruthy();
    expect(container.querySelector("[data-better-sidebar-scope-chip]")).toBeNull();
    expect(screen.queryByLabelText(/clear project filter/i)).toBeNull();
  });

  it("shows the scoped project as a chip whose clear control restores All projects (B76.2)", () => {
    const onProjectFilterChange = vi.fn();
    const { container } = renderMenu(false, {
      projectFilter: "p2",
      onProjectFilterChange,
    });
    const chip = container.querySelector("[data-better-sidebar-scope-chip]");
    expect(chip?.textContent).toContain("Beta");

    fireEvent.click(screen.getByLabelText(/clear project filter/i));
    expect(onProjectFilterChange).toHaveBeenCalledWith(ALL_PROJECTS);
  });

  it("names an unknown scoped id rather than rendering an empty chip", () => {
    const { container } = renderMenu(false, { projectFilter: "gone" });
    expect(
      container.querySelector("[data-better-sidebar-scope-chip]")?.textContent,
    ).toContain("gone");
  });

  it("carries no horizontal inset of its own (B73.2)", () => {
    const { container } = renderMenu(false);
    const root = container.querySelector("[data-better-sidebar-display-options]");
    const classes = (root?.getAttribute("class") ?? "").split(/\s+/);
    expect(classes.filter((token) => /^(p|px|pl|pr)-/.test(token))).toEqual([]);
  });
});

describe.each(SHAPES)("DisplayMenu — $name", ({ isCompactViewport }) => {
  it("portal-scopes every content element it mounts (B76.5, B79.7)", () => {
    const groupBySection = section(isCompactViewport, "Group by");
    const content = screen.getByRole("menu", { name: "Display options" });
    const scoped = isCompactViewport ? [content] : [content, groupBySection];
    for (const node of scoped) {
      expect(node.getAttribute("data-bb-portaled-overlay")).toBe("");
      expect(node.getAttribute("data-bb-plugin-root")).toBe("");
    }
  });

  it("offers Group by and Filter, and none of the other six settings (B76.6)", () => {
    openMenu(isCompactViewport);
    const content = screen.getByRole("menu", { name: "Display options" });
    expect(content.textContent).toContain("Group by");
    expect(content.textContent).toContain("Filter");
    for (const absent of [
      /density/i,
      /pr chip/i,
      /provider/i,
      /relative time/i,
      /archived/i,
      /header chip/i,
    ]) {
      expect(content.textContent).not.toMatch(absent);
    }
  });

  it("lists the five grouping values with the active one checked (B77.1)", () => {
    const menu = section(isCompactViewport, "Group by");
    expect(itemLabels(menu)).toEqual(["Date", "Project", "Host", "Status", "None"]);
    expect(checkedLabels(menu)).toEqual(["Date"]);
  });

  it("reports the chosen grouping", () => {
    const onGroupByChange = vi.fn();
    renderMenu(isCompactViewport, { onGroupByChange });
    section(isCompactViewport, "Group by");
    fireEvent.click(screen.getByText("Status"));
    expect(onGroupByChange).toHaveBeenCalledWith("status");
  });

  it("lists All projects then each project by name (B78.1)", () => {
    expect(itemLabels(section(isCompactViewport, "Filter"))).toEqual([
      "All projects",
      "bb-plugins",
      "Beta",
    ]);
  });

  it("checks the item matching the active scope (B78.4)", () => {
    expect(checkedLabels(section(isCompactViewport, "Filter"))).toEqual(["All projects"]);
    cleanup();

    renderMenu(isCompactViewport, { projectFilter: "p2" });
    expect(checkedLabels(section(isCompactViewport, "Filter"))).toEqual(["Beta"]);
  });

  it("reports the chosen project id", () => {
    const onProjectFilterChange = vi.fn();
    renderMenu(isCompactViewport, { onProjectFilterChange });
    section(isCompactViewport, "Filter");
    fireEvent.click(screen.getByText("Beta"));
    expect(onProjectFilterChange).toHaveBeenCalledWith("p2");
  });

  it("renders All projects alone when the account has no projects yet", () => {
    renderMenu(isCompactViewport, { projects: [] });
    expect(itemLabels(section(isCompactViewport, "Filter"))).toEqual(["All projects"]);
  });

  /**
   * B79.1, B79.2 and B79.5. jsdom runs no layout, so a menu at x = -335
   * measures the same as one at x = 8 and the placement itself is a
   * browser-only check. The props that produce the placement are what jsdom
   * can see.
   */
  it("caps its width and height against the viewport and scrolls", () => {
    openMenu(isCompactViewport);
    const contents = [screen.getByRole("menu", { name: "Display options" })];
    if (!isCompactViewport) {
      fireEvent.click(screen.getByRole("menuitem", { name: "Filter" }));
      contents.push(screen.getByRole("menu", { name: "Filter" }));
    }

    for (const node of contents) {
      const classes = node.getAttribute("class") ?? "";
      expect(classes).toContain("min-w-40");
      expect(classes).toContain(
        "max-w-[var(--radix-dropdown-menu-content-available-width)]",
      );
      expect(classes).toContain(
        "max-h-[var(--radix-dropdown-menu-content-available-height)]",
      );
      expect(classes).toContain("overflow-y-auto");
    }
  });
});

describe("DisplayMenu — the shapes differ only in layout (B79.3)", () => {
  it("mounts no Sub at a compact viewport", () => {
    openMenu(true);
    expect(screen.queryByRole("menuitem", { name: "Group by" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Filter" })).toBeNull();
    const content = screen.getByRole("menu", { name: "Display options" });
    // A `SubTrigger` is the only thing inside the menu that opens a menu.
    expect(content.querySelectorAll('[aria-haspopup="menu"]')).toHaveLength(0);

    // Both sets are in the one menu instead, in the amendment's order.
    expect(itemLabels(content)).toEqual([
      "Date",
      "Project",
      "Host",
      "Status",
      "None",
      "All projects",
      "bb-plugins",
      "Beta",
    ]);
  });

  it("mounts a Sub per section at a wide viewport", () => {
    openMenu(false);
    const content = screen.getByRole("menu", { name: "Display options" });
    const labels = Array.from(content.querySelectorAll('[role="menuitem"]')).map(
      (node) => node.textContent?.trim() ?? "",
    );
    expect(labels).toEqual(["Group by", "Filter"]);
    expect(itemLabels(content)).toEqual([]);
  });
});
