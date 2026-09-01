import type { ReactNode } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { PluginSidebarProject } from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils";
import { usePortalScopeProps } from "./lib/portal-scope";
import { CONTROL_BUTTON_CLASS } from "./ui/control-button";
import { COLLISION_PADDING } from "./ui/overlay";
import { Glyph } from "./ui/Glyph";
import type { GroupBy } from "./model/types";

export const ALL_PROJECTS = "";

/**
 * B79.1, B79.2 and B79.5. Radix publishes the space it measured between the
 * trigger and the collision boundary as these two CSS variables, so the cap is
 * the viewport itself and needs no pixel constant. `min-w-40` stays the floor,
 * the variable is the ceiling, and a long project name truncates inside it
 * instead of widening the menu. The height cap plus `overflow-y-auto` keeps the
 * last item of a twenty-project list reachable.
 */
const MENU_SURFACE = cn(
  "z-50 min-w-40 max-w-[var(--radix-dropdown-menu-content-available-width)]",
  "max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto",
  "rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md",
);



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
  isCompactViewport = false,
}: {
  projects: readonly PluginSidebarProject[];
  /** A project id, or `ALL_PROJECTS` for no scope. */
  projectFilter: string;
  onProjectFilterChange: (value: string) => void;
  groupBy: GroupBy;
  onGroupByChange: (value: GroupBy) => void;
  /** B79.3: a narrow panel gets the flat shape, with no `Sub` mounted. */
  isCompactViewport?: boolean;
}) {
  const portalScope = usePortalScopeProps();
  const groupByItems = (
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
  );
  // B78.4: the checked item answers "what am I looking at" without closing the
  // menu.
  const filterItems = (
    <DropdownMenu.RadioGroup value={projectFilter} onValueChange={onProjectFilterChange}>
      <RadioItem value={ALL_PROJECTS}>All projects</RadioItem>
      {projects.map((project) => (
        <RadioItem key={project.id} value={project.id}>
          {project.name}
        </RadioItem>
      ))}
    </DropdownMenu.RadioGroup>
  );
  const scopedProject =
    projectFilter === ALL_PROJECTS
      ? null
      : (projects.find((project) => project.id === projectFilter)?.name ?? projectFilter);

  return (
    <div
      data-better-sidebar-display-options=""
      // Inline in the first section header now, not a row of its own: no
      // height and no vertical padding, or it would stretch the header it
      // sits in. The header carries the row's inset (`ROW_INSET_PX`) for both.
      className="relative flex items-center gap-1"
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
          className={CONTROL_BUTTON_CLASS}
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
            collisionPadding={COLLISION_PADDING}
            aria-label="Display options"
            className={MENU_SURFACE}
          >
            {isCompactViewport ? (
              // B79.3: a menu beside a menu does not fit a 320px panel, so the
              // compact shape mounts no `Sub` at all — the two sets become two
              // labelled groups in the one menu, separated by a rule.
              <>
                <Section label="Group by">{groupByItems}</Section>
                <DropdownMenu.Separator className="-mx-1 my-1 h-px bg-border" />
                <Section label="Filter">{filterItems}</Section>
              </>
            ) : (
              <>
                <Sub label="Group by" portalScope={portalScope}>
                  {groupByItems}
                </Sub>
                <Sub label="Filter" portalScope={portalScope}>
                  {filterItems}
                </Sub>
              </>
            )}
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
        <span className="flex-1 truncate">{label}</span>
        <Glyph name="chevron-right" aria-hidden="true" className="size-3" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          {...portalScope}
          sideOffset={2}
          collisionPadding={COLLISION_PADDING}
          aria-label={label}
          className={MENU_SURFACE}
        >
          {children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

/**
 * One labelled group of the flat compact menu (B79.3). It carries the label as
 * its accessible name, so a test and a screen reader address it the same way a
 * submenu is addressed in the nested shape.
 */
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu.Group aria-label={label}>
      <DropdownMenu.Label className="truncate px-2 py-1 text-[11px] font-medium text-muted-foreground">
        {label}
      </DropdownMenu.Label>
      {children}
    </DropdownMenu.Group>
  );
}

function RadioItem({ value, children }: { value: string; children: ReactNode }) {
  return (
    <DropdownMenu.RadioItem
      value={value}
      className={cn(
        "flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none",
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
