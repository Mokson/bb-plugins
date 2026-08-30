// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import { ALL_PROJECTS, ProjectFilter } from "./ProjectFilter";

const PROJECTS: PluginSidebarProject[] = [
  { id: "p1", name: "bb-plugins", isPersonal: false },
  { id: "p2", name: "Beta", isPersonal: false },
];

afterEach(cleanup);

describe("ProjectFilter (B64.1)", () => {
  it("lists All projects first, then every project by name", () => {
    render(
      <ProjectFilter projects={PROJECTS} value={ALL_PROJECTS} onChange={() => {}} />,
    );
    const options = Array.from(
      screen.getByLabelText(/filter by project/i).querySelectorAll("option"),
    );
    expect(options.map((option) => option.textContent)).toEqual([
      "All projects",
      "bb-plugins",
      "Beta",
    ]);
    expect(options.map((option) => option.getAttribute("value"))).toEqual([
      ALL_PROJECTS,
      "p1",
      "p2",
    ]);
  });

  it("reports the chosen project id, and the empty value for All projects", () => {
    const onChange = vi.fn();
    render(<ProjectFilter projects={PROJECTS} value="p1" onChange={onChange} />);
    const select = screen.getByLabelText(/filter by project/i);
    expect((select as HTMLSelectElement).value).toBe("p1");

    fireEvent.change(select, { target: { value: "p2" } });
    expect(onChange).toHaveBeenCalledWith("p2");

    fireEvent.change(select, { target: { value: ALL_PROJECTS } });
    expect(onChange).toHaveBeenLastCalledWith(ALL_PROJECTS);
  });

  it("is a controlled input, so the caller's session state is the only source", () => {
    const view = render(
      <ProjectFilter projects={PROJECTS} value={ALL_PROJECTS} onChange={() => {}} />,
    );
    const select = screen.getByLabelText(/filter by project/i) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "p2" } });
    // The ignored `onChange` means the value must snap back: nothing about the
    // scope is held inside this component (B64.2).
    expect(select.value).toBe(ALL_PROJECTS);
    view.rerender(
      <ProjectFilter projects={PROJECTS} value="p2" onChange={() => {}} />,
    );
    expect(select.value).toBe("p2");
  });

  /**
   * B73.2. The filter sits inside the scroll container, which now carries the
   * panel's single 8px column. An inset of its own would sit the filter at
   * 16px while the rows sat at 8px.
   */
  it("carries no horizontal inset of its own (B73.2)", () => {
    const { container } = render(
      <ProjectFilter projects={PROJECTS} value={ALL_PROJECTS} onChange={() => {}} />,
    );
    const root = container.querySelector("[data-better-sidebar-project-filter]");
    const classes = (root?.getAttribute("class") ?? "").split(/\s+/);
    expect(classes.filter((token) => /^(p|px|pl|pr)-/.test(token))).toEqual([]);
  });

  it("renders All projects alone when the account has no projects yet", () => {
    render(<ProjectFilter projects={[]} value={ALL_PROJECTS} onChange={() => {}} />);
    expect(
      screen.getByLabelText(/filter by project/i).querySelectorAll("option"),
    ).toHaveLength(1);
  });
});
