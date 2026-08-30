import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useSettings,
  type PluginSidebarThread,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils";
import { parseSettings } from "./settings";
import { buildListModel, sectionKeyOf } from "./model/list-model";
import { dimLevelFor } from "./model/buckets";
import type { Density, GroupBy, RenderSection } from "./model/types";
import { ALL_PROJECTS, DisplayMenu } from "./DisplayMenu";
import { ThreadRow } from "./row/ThreadRow";
import { useLastActivity } from "./row/useLastActivity";
import { Glyph } from "./ui/Glyph";
import { ListEmpty, ListError, ListLoading, ListNoMatches } from "./ui/ListStates";
import { useCollapse } from "./useCollapse";
import { useGroupBy } from "./useGroupBy";
import { useSectionOrder } from "./useSectionOrder";
import { useNow } from "./useNow";
import { matchBucketJump, nextSectionIndex } from "./keyboard/bucketJump";

/**
 * The sidebar thread list.
 *
 * `experimental_useSidebarThreads()` has no refetch, so the retry affordance of
 * the error state can only re-run the subscription by remounting the component
 * that holds it. That is what this wrapper's key is for; everything else lives
 * in `ThreadListBody`.
 */
export function ThreadList(props: PluginThreadListProps) {
  const [attempt, setAttempt] = useState(0);
  return (
    <ThreadListBody
      key={attempt}
      {...props}
      onRetry={() => setAttempt((current) => current + 1)}
    />
  );
}

function ThreadListBody({
  isCompactViewport,
  onNavigate,
  searchQuery,
  onRetry,
}: PluginThreadListProps & { onRetry: () => void }) {
  const { status, threads, projects } = useSidebarThreads();
  const stored = parseSettings(useSettings().values);
  // B77.3: the menu's stored choice wins, and the setting is the default this
  // device uses until its user picks one. Everything downstream reads the
  // resolved value, so no call site has to know which of the two it came from.
  const groupByState = useGroupBy(stored.groupBy);
  const settings = { ...stored, groupBy: groupByState.groupBy };
  const now = useNow();
  const collapse = useCollapse();
  // B64.2: session state. Never settings, never `localStorage`, never the
  // backend — a filter that outlives the tab hides work the user forgot about.
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS);

  // B68.5: the reconciler sees the UNFILTERED set. Scope and search are
  // presentation, so a thread they hide has not left its section, and clearing
  // one must not reshuffle the list.
  const sectionOf = useCallback(
    (thread: PluginSidebarThread) => sectionKeyOf(thread, settings, now),
    [settings.groupBy, now],
  );
  const sectionOrder = useSectionOrder(threads, sectionOf);

  const model = useMemo(
    () =>
      buildListModel({
        threads,
        projects,
        settings,
        searchQuery,
        now,
        projectFilter: projectFilter === ALL_PROJECTS ? null : projectFilter,
        sectionOrder,
        collapsedSections: collapse.collapsedSections,
        collapsedThreadIds: collapse.collapsedThreadIds,
      }),
    [
      threads,
      projects,
      settings.groupBy,
      settings.density,
      settings.showArchivedChildren,
      searchQuery,
      now,
      projectFilter,
      sectionOrder,
      collapse.collapsedSections,
      collapse.collapsedThreadIds,
    ],
  );

  // B82: one batched lookup for every rendered row, owned here rather than by
  // the row, so a list of 130 threads issues three requests and not 130. The
  // ids come from the model, so a collapsed subtree is not asked about.
  const renderedThreadIds = useMemo(
    () => model.sections.flatMap((section) => section.rows.map((row) => row.thread.id)),
    [model],
  );
  const lastActivity = useLastActivity(renderedThreadIds);

  const headersRef = useRef<(HTMLElement | null)[]>([]);
  const jumpIndexRef = useRef(-1);
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const direction = matchBucketJump(event);
    if (direction === null) return;
    const headers = headersRef.current;
    const index = nextSectionIndex(jumpIndexRef.current, direction, headers.length);
    const header = index < 0 ? null : headers[index];
    if (!header) return;
    event.preventDefault();
    jumpIndexRef.current = index;
    header.scrollIntoView({ block: "start" });
    header.focus();
  }, []);

  if (status === "loading") return <ListLoading />;
  if (status === "error") return <ListError onRetry={onRetry} />;

  const scopedProject =
    projectFilter === ALL_PROJECTS
      ? undefined
      : (projects.find((project) => project.id === projectFilter)?.name ?? projectFilter);

  // B64.5: the control renders above every ready state, compact included —
  // including the empty ones, which is the only place the user can undo a scope
  // that hid everything.
  const displayMenu = (
    <DisplayMenu
      projects={projects}
      projectFilter={projectFilter}
      onProjectFilterChange={setProjectFilter}
      groupBy={settings.groupBy}
      onGroupByChange={groupByState.setGroupBy}
      // B79.4: a 320px panel gets the flat menu, which fits it.
      isCompactViewport={isCompactViewport}
    />
  );

  if (model.sections.length === 0) {
    // B64.4: a scope or a search that matched nothing is never the generic
    // "no threads yet", which would be a lie about an account that has plenty.
    const narrowed = searchQuery.trim() !== "" || scopedProject !== undefined;
    return (
      <div data-better-sidebar-list="" className="flex h-full flex-col overflow-y-auto py-1">
        {displayMenu}
        {narrowed ? (
          <ListNoMatches query={searchQuery} projectName={scopedProject} />
        ) : (
          <ListEmpty />
        )}
      </div>
    );
  }

  const showSecondRow = showsSecondRow(settings.density, settings.groupBy);
  // Rebuilt each render so the jump table cannot outlive the sections it indexes.
  headersRef.current = [];

  return (
    <div
      data-better-sidebar-list=""
      // B73.1: the whole panel sits on one 8px column, and the scroll
      // container is what carries it. The rows, the section headers and the
      // project filter each carried their own inset before, which put chrome
      // at 8px and rows at 0 (B73.2).
      className="flex h-full flex-col overflow-y-auto px-2 py-1"
      onKeyDown={onKeyDown}
    >
      {displayMenu}
      {model.sections.map((section, index) => (
        <section key={section.key} data-sidebar-section={section.key}>
          <SectionHeader
            section={section}
            onToggle={() => collapse.toggleSection(section.key)}
            ref={(node) => {
              headersRef.current[index] = node;
            }}
          />
          {section.rows.map((row) => (
            <ThreadRow
              key={row.thread.id}
              row={row}
              now={now}
              // B82: the row's own `updatedAt` until the lookup lands.
              lastActivityAt={lastActivity.get(row.thread.id)}
              showSecondRow={showSecondRow}
              // B61: each of these skips work, not pixels — the PR hook is
              // never called and the signal observer is never mounted.
              showPrChip={settings.showPrChip}
              showProviderGlyph={settings.showProviderGlyph}
              showRelativeTime={settings.showRelativeTime}
              showSignals={settings.density === "detailed"}
              isCompactViewport={isCompactViewport}
              // B47: the host clears its search field and closes the mobile
              // drawer here, so every open path goes through it.
              onNavigate={onNavigate}
              isSubtreeCollapsed={collapse.collapsedThreadIds.has(row.thread.id)}
              onToggleSubtree={
                row.childCount > 0 ? () => collapse.toggleThread(row.thread.id) : undefined
              }
            />
          ))}
        </section>
      ))}
    </div>
  );
}

/**
 * B60: `default` means "row 2 unless the grouping already says it". Grouping
 * by project puts the project name in the header, so repeating it under every
 * title is noise; `detailed` and `compact` are the user overriding that
 * judgement in each direction.
 */
function showsSecondRow(density: Density, groupBy: GroupBy): boolean {
  if (density === "detailed") return true;
  if (density === "compact") return false;
  return groupBy !== "project";
}

function SectionHeader({
  section,
  onToggle,
  ref,
}: {
  section: RenderSection;
  onToggle: () => void;
  ref: (node: HTMLElement | null) => void;
}) {
  // B53.1: the count sits at the far right of the header row. Left-adjacent it
  // read as part of the label — `TODAY 22` looked like a title, not a tally.
  const label = (
    <>
      <span className="flex-1 truncate text-left">{section.label}</span>
      <span className="tabular-nums text-muted-foreground/70">{section.count}</span>
    </>
  );
  const className = cn(
    // B73.2: no inset of its own. The scroll container carries the 8px column,
    // so the header's left edge and row 1's left edge are the same edge.
    "flex w-full items-center gap-1.5 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide",
    "text-muted-foreground",
    dimClassFor(section),
  );

  // B7: `NEEDS YOU` and `PINNED` are attention states, not folders — a control
  // that could hide them would defeat the reason they are hoisted at all.
  if (!section.isCollapsible) {
    return (
      <h2 ref={ref} tabIndex={-1} className={className}>
        {label}
      </h2>
    );
  }
  return (
    <h2 className="contents">
      <button
        ref={ref}
        type="button"
        tabIndex={-1}
        onClick={onToggle}
        aria-expanded={!section.isCollapsed}
        className={cn(className, "hover:text-foreground")}
      >
        <Glyph
          name={section.isCollapsed ? "chevron-right" : "chevron-down"}
          className="size-3 shrink-0"
        />
        {label}
      </button>
    </h2>
  );
}

/**
 * B41: the gradient reaches section headers, never a row-1 title.
 *
 * Derived from the section key, not from `rows[0]` — a collapsed section has
 * no rows at all, so reading the first one made every collapsed header render
 * fully opaque and broke the gradient exactly where it is most visible.
 */
function dimClassFor(section: RenderSection): string {
  return ["", "opacity-90", "opacity-80", "opacity-70"][dimLevelFor(section.key)] ?? "";
}
