import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils";
import { Glyph } from "./ui/Glyph";

export const ALL_PROJECTS = "";

/**
 * B64.1: the project scope control, and the only filter this sidebar ships.
 *
 * A native `<select>` rather than a portalled listbox. It is one row of chrome
 * at every viewport (B64.5), it needs no portal scope to stay inside the
 * plugin's style boundary, and on a phone it opens the platform's own picker —
 * which is the viewport B64.5 exists for. Keyboard and screen-reader behaviour
 * come from the element rather than from re-implemented roving focus.
 *
 * The value is held by the caller as component state (B64.2): a filter you
 * forgot you set makes threads silently disappear, so it must not survive a
 * reload, and it is deliberately reachable from neither settings, nor
 * `localStorage`, nor the backend.
 */
export function ProjectFilter({
  projects,
  value,
  onChange,
}: {
  projects: readonly PluginSidebarProject[];
  /** A project id, or `ALL_PROJECTS` for no scope. */
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div
      data-better-sidebar-project-filter=""
      // B73.2: no inset of its own. The scroll container carries the 8px
      // column for every child; a second inset here would sit chrome at 16px.
      className="relative flex items-center pb-1 pt-1"
    >
      <Glyph
        name="chevron-down"
        aria-hidden="true"
        className="pointer-events-none absolute right-3.5 size-3 shrink-0 text-muted-foreground"
      />
      <select
        aria-label="Filter by project"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(
          "h-6 w-full appearance-none rounded border border-border bg-transparent",
          "pl-1.5 pr-5 text-[11px] text-muted-foreground",
          "hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring",
        )}
      >
        <option value={ALL_PROJECTS}>All projects</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </div>
  );
}
