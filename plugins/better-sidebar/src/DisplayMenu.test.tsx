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

function renderMenu(
  overrides: {
    projectFilter?: string;
    groupBy?: GroupBy;
    onProjectFilterChange?: (value: string) => void;
    onGroupByChange?: (value: GroupBy) => void;
  } = {},
) {
  return render(
    <DisplayMenu
      projects={PROJECTS}
      projectFilter={overrides.projectFilter ?? ALL_PROJECTS}
      onProjectFilterChange={overrides.onProjectFilterChange ?? (() => {})}
      groupBy={overrides.groupBy ?? "date"}
      onGroupByChange={overrides.onGroupByChange ?? (() => {})}
    />,
  );
}

/** Radix opens a dropdown from the keyboard with no pointer shims in jsdom. */
function openMenu() {
  // Most cases want the default props, so opening implies the default render.
  if (screen.queryByLabelText("Display options") === null) renderMenu();
  fireEvent.keyDown(screen.getByLabelText("Display options"), { key: "Enter" });
}

function openSub(label: string) {
  openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: label }));
  return screen.getByRole("menu", { name: label });
}

function itemLabels(menu: HTMLElement): string[] {
  return Array.from(menu.querySelectorAll('[role="menuitemradio"]')).map(
    (node) => node.textContent?.trim() ?? "",
  );
}

describe("DisplayMenu — the row and its trigger (B76)", () => {
  it("is the trigger alone with no scope active (B76.3)", () => {
    const { container } = renderMenu();
    expect(screen.getByLabelText("Display options")).toBeTruthy();
    expect(container.querySelector("[data-better-sidebar-scope-chip]")).toBeNull();
    expect(screen.queryByLabelText(/clear project filter/i)).toBeNull();
  });

  it("shows the scoped project as a chip whose clear control restores All projects (B76.2)", () => {
    const onProjectFilterChange = vi.fn();
    const { container } = renderMenu({ projectFilter: "p2", onProjectFilterChange });
    const chip = container.querySelector("[data-better-sidebar-scope-chip]");
    expect(chip?.textContent).toContain("Beta");

    fireEvent.click(screen.getByLabelText(/clear project filter/i));
    expect(onProjectFilterChange).toHaveBeenCalledWith(ALL_PROJECTS);
  });

  it("names an unknown scoped id rather than rendering an empty chip", () => {
    const { container } = renderMenu({ projectFilter: "gone" });
    expect(
      container.querySelector("[data-better-sidebar-scope-chip]")?.textContent,
    ).toContain("gone");
  });

  it("carries no horizontal inset of its own (B73.2)", () => {
    const { container } = renderMenu();
    const root = container.querySelector("[data-better-sidebar-display-options]");
    const classes = (root?.getAttribute("class") ?? "").split(/\s+/);
    expect(classes.filter((token) => /^(p|px|pl|pr)-/.test(token))).toEqual([]);
  });

  it("portal-scopes the menu and both submenus (B76.5)", () => {
    const menu = openSub("Group by");
    const content = screen.getByRole("menu", { name: "Display options" });
    for (const node of [content, menu]) {
      expect(node.getAttribute("data-bb-portaled-overlay")).toBe("");
      expect(node.getAttribute("data-bb-plugin-root")).toBe("");
    }
  });

  it("offers Group by and Filter, and none of the other six settings (B76.6)", () => {
    openMenu();
    const content = screen.getByRole("menu", { name: "Display options" });
    const labels = Array.from(content.querySelectorAll('[role="menuitem"]')).map(
      (node) => node.textContent?.trim() ?? "",
    );
    expect(labels).toEqual(["Group by", "Filter"]);
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
});

describe("DisplayMenu — Group by (B77)", () => {
  it("lists the five values as a radio group with the active one checked (B77.1)", () => {
    const menu = openSub("Group by");
    expect(itemLabels(menu)).toEqual(["Date", "Project", "Host", "Status", "None"]);
    const checked = Array.from(menu.querySelectorAll('[aria-checked="true"]')).map(
      (node) => node.textContent?.trim(),
    );
    expect(checked).toEqual(["Date"]);
  });

  it("reports the chosen grouping", () => {
    const onGroupByChange = vi.fn();
    renderMenu({ onGroupByChange });
    openSub("Group by");
    fireEvent.click(screen.getByText("Status"));
    expect(onGroupByChange).toHaveBeenCalledWith("status");
  });
});

describe("DisplayMenu — Filter by project (B78)", () => {
  it("lists All projects then each project by name (B78.1)", () => {
    const menu = openSub("Filter");
    expect(itemLabels(menu)).toEqual(["All projects", "bb-plugins", "Beta"]);
  });

  it("checks the item matching the active scope (B78.4)", () => {
    const menu = openSub("Filter");
    expect(
      Array.from(menu.querySelectorAll('[aria-checked="true"]')).map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["All projects"]);
    cleanup();

    renderMenu({ projectFilter: "p2" });
    const scoped = openSub("Filter");
    expect(
      Array.from(scoped.querySelectorAll('[aria-checked="true"]')).map((node) =>
        node.textContent?.trim(),
      ),
    ).toEqual(["Beta"]);
  });

  it("reports the chosen project id", () => {
    const onProjectFilterChange = vi.fn();
    renderMenu({ onProjectFilterChange });
    openSub("Filter");
    fireEvent.click(screen.getByText("Beta"));
    expect(onProjectFilterChange).toHaveBeenCalledWith("p2");
  });

  it("renders All projects alone when the account has no projects yet", () => {
    render(
      <DisplayMenu
        projects={[]}
        projectFilter={ALL_PROJECTS}
        onProjectFilterChange={() => {}}
        groupBy="date"
        onGroupByChange={() => {}}
      />,
    );
    expect(itemLabels(openSub("Filter"))).toEqual(["All projects"]);
  });
});
