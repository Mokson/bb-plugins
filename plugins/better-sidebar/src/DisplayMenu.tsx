import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils";
import { usePortalScopeProps } from "./lib/portal-scope";
import { Glyph } from "./ui/Glyph";
import type { GroupBy } from "./model/types";

export const ALL_PROJECTS = "";

/** B65's five values, in the order the settings form lists them. */
const GROUP_BY_OPTIONS: readonly { value: GroupBy; label: string }[] = [
  { value: "date", label: "Date" },
  { value: "project", label: "Project" },
  { value: "host", label: "Host" },
  { value: "status", label: "Status" },
  { value: "none", label: "None" },
];

/**
 * The display-options row at the top of the list (B76).
 *
 * B64.1's full-width `Select` is replaced by one icon button that opens a
 * dropdown with two submenus: Group by (B77) and Filter by project (B78). The
 * resting row is the button alone, so it costs ~24px instead of ~32px
 * (B76.3), and the button is a visible trigger at every viewport — a phone has
 * no right-click, so binding this to a context-menu gesture would put the
 * filter out of reach exactly where B64.5 requires it (B76.4).
 *
 * Hiding the control must not hide the fact that the list is scoped, so an
 * active project scope renders as a chip on the left of the same row, with its
 * own clear control (B76.2).
 *
 * The other six settings stay in bb's settings form (B76.6): they are set
 * once, not changed while reading the list.
 *
 * The two values behave differently on purpose. `groupBy` persists to
 * `localStorage` (B77.2); the project scope is the caller's component state
 * and reaches neither settings, nor `localStorage`, nor the backend (B78.2) —
 * a filter you forgot you set must not outlive the tab.
 */
export function DisplayMenu({
  projects,
  projectFilter,
  onProjectFilterChange,
  groupBy,
  onGroupByChange,
}: {
  projects: readonly PluginSidebarProject[];
  /** A project id, or `ALL_PROJECTS` for no scope. */
  projectFilter: string;
  onProjectFilterChange: (value: string) => void;
  groupBy: GroupBy;
  onGroupByChange: (value: GroupBy) => void;
}) {
  const portalScope = usePortalScopeProps();
  const scopedProject =
    projectFilter === ALL_PROJECTS
      ? null
      : (projects.find((project) => project.id === projectFilter)?.name ?? projectFilter);

  return (
    <div
      data-better-sidebar-display-options=""
      // B73.2: no inset of its own. The scroll container carries the 8px
      // column for every child; a second inset here would sit chrome at 16px.
      className="relative flex h-6 items-center gap-1 pb-1 pt-1"
    >
      {scopedProject === null ? null : (
        <span
          data-better-sidebar-scope-chip=""
          className={cn(
            "flex min-w-0 items-center gap-1 rounded border border-border",
            "px-1.5 text-[11px] text-muted-foreground",
          )}
        >
          <span className="truncate">{scopedProject}</span>
          <button
            type="button"
            aria-label="Clear project filter"
            onClick={() => onProjectFilterChange(ALL_PROJECTS)}
            className="shrink-0 hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <Glyph name="x" className="size-3" />
          </button>
        </span>
      )}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          aria-label="Display options"
          className={cn(
            "ml-auto flex size-5 shrink-0 items-center justify-center rounded",
            "text-muted-foreground hover:text-foreground",
            "focus:outline-none focus:ring-1 focus:ring-ring",
          )}
        >
          <Glyph name="sliders" aria-hidden="true" className="size-3.5" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          {/* B76.5: portalled content leaves the plugin mount, so it carries
              the plugin's style scope back with it. */}
          <DropdownMenu.Content
            {...portalScope}
            align="end"
            sideOffset={4}
            aria-label="Display options"
            className="z-50 min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
          >
            <Sub label="Group by" portalScope={portalScope}>
              <DropdownMenu.RadioGroup
                value={groupBy}
                onValueChange={(value) => onGroupByChange(value as GroupBy)}
              >
                {GROUP_BY_OPTIONS.map((option) => (
                  <RadioItem key={option.value} value={option.value}>
                    {option.label}
                  </RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </Sub>
            <Sub label="Filter" portalScope={portalScope}>
              {/* B78.4: the checked item answers "what am I looking at"
                  without closing the menu. */}
              <DropdownMenu.RadioGroup
                value={projectFilter}
                onValueChange={onProjectFilterChange}
              >
                <RadioItem value={ALL_PROJECTS}>All projects</RadioItem>
                {projects.map((project) => (
                  <RadioItem key={project.id} value={project.id}>
                    {project.name}
                  </RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </Sub>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

function Sub({
  label,
  portalScope,
  children,
}: {
  label: string;
  portalScope: ReturnType<typeof usePortalScopeProps>;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger
        className={cn(
          "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
          "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
          "data-[state=open]:bg-accent data-[state=open]:text-accent-foreground",
        )}
      >
        <span className="flex-1">{label}</span>
        <Glyph name="chevron-right" aria-hidden="true" className="size-3" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          {...portalScope}
          sideOffset={2}
          aria-label={label}
          className="z-50 min-w-40 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

function RadioItem({ value, children }: { value: string; children: ReactNode }) {
  return (
    <DropdownMenu.RadioItem
      value={value}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
        "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
      )}
    >
      <span className="flex size-3 shrink-0 items-center justify-center">
        <DropdownMenu.ItemIndicator>
          <Glyph name="check" className="size-3" />
        </DropdownMenu.ItemIndicator>
      </span>
      <span className="truncate">{children}</span>
    </DropdownMenu.RadioItem>
  );
}
