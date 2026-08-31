import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useSettings,
  type PluginSidebarThread,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils";
import { useResolvedSettings } from "./useResolvedSettings";
import { buildListModel, sectionKeyOf, usesHostLabel } from "./model/list-model";
import { ROW1_ICON } from "./row/row-metrics";
import { useLocalHostId } from "./row/useLocalHostId";
import { useThreadExecutions } from "./header/useThreadExecutions";
import { dimLevelFor } from "./model/buckets";
import type { Density, GroupBy, RenderSection } from "./model/types";
import { ALL_PROJECTS, DisplayMenu } from "./DisplayMenu";
import { ThreadRow } from "./row/ThreadRow";
import { useLastActivity } from "./row/useLastActivity";
import { CONTROL_BUTTON_CLASS } from "./ui/control-button";
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
  const live = useSidebarThreads();
  const { status } = live;
  // The last answer the host actually gave. A subscription that re-enters
  // `loading` while it refreshes reports no threads meanwhile, and painting
  // that emptiness — as a skeleton, or as "No threads yet" — is the list
  // flickering between updates. Held here so the previous answer stays on
  // screen until the next one replaces it.
  const hasLoadedRef = useRef(false);
  const lastReadyRef = useRef<{ threads: typeof live.threads; projects: typeof live.projects }>({
    threads: [],
    projects: [],
  });
  if (status === "ready") {
    hasLoadedRef.current = true;
    lastReadyRef.current = { threads: live.threads, projects: live.projects };
  }
  const { threads, projects } =
    status === "ready" ? live : lastReadyRef.current;
  // B83: the last known settings until the host's answer lands, so the list
  // does not paint with defaults and re-lay-out seconds later.
  const stored = useResolvedSettings(useSettings().values);
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
  const navigate = useBbNavigate();
  // The setting is a hard off-switch; with it on, B60's density and grouping
  // rule still decides.
  const showSecondRow =
    settings.showSecondRow && showsSecondRow(settings.density, settings.groupBy);
  // B61: a machine name is only ever drawn as the branch label's last resort,
  // so every switch that hides that label also cancels the request — and so
  // does a list where no thread's chain reaches the machine step at all.
  const localHostId = useLocalHostId(
    showSecondRow && settings.showBranch && threads.some(usesHostLabel),
  );

  const model = useMemo(
    () =>
      buildListModel({
        threads,
        projects,
        settings,
        searchQuery,
        now,
        projectFilter: projectFilter === ALL_PROJECTS ? null : projectFilter,
        localHostId,
        sectionOrder,
        collapsedSections: collapse.collapsedSections,
        expandedThreadIds: collapse.expandedThreadIds,
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
      localHostId,
      sectionOrder,
      collapse.collapsedSections,
      collapse.expandedThreadIds,
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

  /*
   * B61: model and effort are fetched for the rows the list is actually
   * drawing, and for nothing else. A collapsed parent's children contribute no
   * id, a hidden second row contributes none, and `showModel: false` empties
   * the set outright — which is the only field on row 2 whose toggle also
   * switches off a request.
   */
  const executionIds = useMemo(
    () =>
      showSecondRow && settings.showModel
        ? model.sections.flatMap((section) =>
            section.rows.map((entry) => entry.thread.id),
          )
        : [],
    [model, showSecondRow, settings.showModel],
  );
  const { executions } = useThreadExecutions(
    executionIds,
    executionIds.length > 0,
  );

  // The skeleton is for a list that has never had content. Once the host has
  // answered once, a later `loading` is a refresh of a list already on screen,
  // and replacing it with six grey bars for the length of that refresh is the
  // whole sidebar flickering.
  if (status === "loading" && !hasLoadedRef.current) return <ListLoading />;
  if (status === "error") return <ListError onRetry={onRetry} />;

  const scopedProject =
    projectFilter === ALL_PROJECTS
      ? undefined
      : (projects.find((project) => project.id === projectFilter)?.name ?? projectFilter);

  // B64.5: the control renders above every ready state, compact included —
  // including the empty ones, which is the only place the user can undo a scope
  // that hid everything.
  const newThread = (
    <button
      type="button"
      aria-label="New thread"
      title="New thread"
      onClick={() => navigate.toCompose({ focusPrompt: true })}
      className={CONTROL_BUTTON_CLASS}
    >
      <Glyph
        name="new-thread"
        aria-hidden="true"
        // bb draws this one at stroke-width 1.5; the bubble plus a `+` is
        // dense enough that the plugin's own 2 reads as a blob at 14px.
        strokeWidth={1.5}
        className="size-4"
      />
    </button>
  );

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

  const controls = (
    <span className="ml-auto flex shrink-0 items-center gap-0.5">
      {newThread}
      {displayMenu}
    </span>
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
      {model.sections.map((section, index) => (
        <section key={section.key} data-sidebar-section={section.key}>
          <SectionHeader
            section={section}
            onToggle={() => collapse.toggleSection(section.key)}
            // The panel's controls live on the FIRST header rather than on a
            // strip of their own: that strip was a whole row spent on two
            // icons, and the header already reaches the same trailing edge.
            actions={index === 0 ? controls : null}
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
              // B71.3: undefined until the batch lands, then the resolved
              // model or null for a thread that never ran.
              execution={executions.get(row.thread.id) ?? null}
              // B61: each of these skips work, not pixels — the PR hook is
              // never called and the signal observer is never mounted.
              showPrChip={settings.showPrChip}
              showProjectName={settings.showProjectName}
              showBranch={settings.showBranch}
              showRelativeTime={settings.showRelativeTime}
              showSignals={settings.density === "detailed"}
              isCompactViewport={isCompactViewport}
              // B47: the host clears its search field and closes the mobile
              // drawer here, so every open path goes through it.
              onNavigate={onNavigate}
              isSubtreeCollapsed={!collapse.expandedThreadIds.has(row.thread.id)}
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
  actions,
  ref,
}: {
  section: RenderSection;
  onToggle: () => void;
  /** The panel's controls, on the first header only. */
  actions?: ReactNode;
  ref: (node: HTMLElement | null) => void;
}) {
  // Superseding B53.1: the header carries its label and nothing else. The
  // tally answered a question nobody asks of a date bucket, and it put a
  // second number in a column the row's own time already owns.
  // `RenderSection.count` is still computed — the model's own root-only rule
  // (B53.4) is tested there — it is simply not drawn.
  // Intrinsic, not `flex-1`: the chevron sits beside the label rather than
  // out at the trailing edge, so the label must not stretch past its text.
  const label = <span className="min-w-0 truncate text-left">{section.label}</span>;
  // The row the header occupies. It is never the focusable element: the
  // collapsible variant nests a button inside it, and the panel's controls
  // are buttons too — one interactive element inside another is invalid, and
  // a click on the display menu would toggle the section under it.
  const rowClass = cn(
    // `px-2` is the row's own inset, so a header's label starts on the same x
    // as the leading MARK of every row beneath it — which is where bb's own
    // sidebar puts it.
    "group/section flex w-full items-center gap-1.5 px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide",
    "text-muted-foreground",
    dimClassFor(section),
  );

  // B7: `NEEDS YOU` and `PINNED` are attention states, not folders — a control
  // that could hide them would defeat the reason they are hoisted at all.
  if (!section.isCollapsible) {
    return (
      <h2 ref={ref} tabIndex={-1} className={rowClass}>
        {label}
        {actions}
      </h2>
    );
  }

  return (
    <h2 className={rowClass}>
      <button
        ref={ref}
        type="button"
        tabIndex={-1}
        onClick={onToggle}
        aria-expanded={!section.isCollapsed}
        className="flex min-w-0 items-center gap-1.5 hover:text-foreground"
      >
        {label}
        {/* Beside the label it controls, not out at the trailing edge: the
            control and the thing it collapses read as one target.

            Revealed when the pointer is anywhere on the HEADER, not only on
            the toggle: the group sits on the row, so reaching for the control
            does not require having already found it — EXCEPT while the
            section is collapsed. A collapsed section persists across reloads,
            so a returning user would meet a header with no rows under it and
            no visible control to open it. The one state that needs saying
            keeps saying it. */}
        <Glyph
          name={section.isCollapsed ? "chevron-right" : "chevron-down"}
          className={cn(
            ROW1_ICON,
            "shrink-0 transition-opacity",
            section.isCollapsed
              ? "opacity-100"
              : "opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100",
          )}
        />
      </button>
      {actions}
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
