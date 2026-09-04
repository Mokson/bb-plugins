import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { useCompleted } from "./useCompleted";
import { CompletedActionsProvider } from "./completed-context";
import { matchCompleteKey } from "./keyboard/completeKey";
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
  activeThreadId,
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
  // Written on commit, read on a later render: writing refs during render is
  // what made this unsafe under concurrent rendering. The previous answer is
  // only ever read when a later render is NOT ready, and effects flush before
  // that render, so nothing observes the one-render lag.
  useEffect(() => {
    if (status === "ready") {
      hasLoadedRef.current = true;
      lastReadyRef.current = { threads: live.threads, projects: live.projects };
    }
  });
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
  // B86: server-backed, so a thread filed here is filed on every bb client.
  const completed = useCompleted(threads);
  // B64.2: session state. Never settings, never `localStorage`, never the
  // backend — a filter that outlives the tab hides work the user forgot about.
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS);

  // B82, list-owned: one batched lookup for EVERY thread, not one per row,
  // so a list of 130 threads issues three requests and not 130. Date mode
  // buckets a thread on its newest event, so the section keys need the
  // answer for threads no row is rendering yet — a resumed thread has to
  // walk out of YESTERDAY before it can render at all.
  const threadIds = useMemo(() => threads.map((thread) => thread.id), [threads]);
  const lastActivity = useLastActivity(threadIds);

  const sectionOf = useCallback(
    // The completion map is passed here too, or the reconciler and the model
    // would disagree about which section a filed thread is in — which is the
    // one thing `sectionKeyOf` exists to prevent. The map, not a set of ids:
    // its timestamps order the COMPLETED subgroup the key may land in.
    (thread: PluginSidebarThread) =>
      sectionKeyOf(thread, settings, now, completed.completedAt, lastActivity),
    [settings.groupBy, now, completed.completedAt, lastActivity],
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
        completedAt: completed.completedAt,
        lastActivity,
        expandedThreadIds: collapse.expandedThreadIds,
        collapsedSections: collapse.collapsedSections,
      }),
    [
      completed.completedAt,
      threads,
      projects,
      settings.groupBy,
      settings.density,
      settings.showArchivedChildren,
      searchQuery,
      now,
      projectFilter,
      lastActivity,
      sectionOrder,
      collapse.collapsedSections,
      collapse.expandedThreadIds,
    ],
  );

  const headersRef = useRef<(HTMLElement | null)[]>([]);
  // The ref callbacks below repopulate indices 0..n-1 on every commit, so a
  // render-time reset would wipe values the commit just attached (refs settle
  // before layout effects). Only a stale tail — sections that shrank — needs
  // dropping, and that is safe to do here.
  useLayoutEffect(() => {
    headersRef.current.length = Math.min(
      headersRef.current.length,
      model.sections.length,
    );
  });
  const jumpIndexRef = useRef(-1);
  const setCompleted = completed.setCompleted;
  const completedAt = completed.completedAt;
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    // B86.6: the shortcut acts on the row the focus is inside, read off the DOM
    // rather than from a selection the list would otherwise have to own. The
    // list has no cursor of its own — focus IS the cursor here, and the row
    // already carries its thread id for the hover card.
    if (matchCompleteKey(event)) {
      const row = (event.target as HTMLElement | null)?.closest?.(
        "[data-better-sidebar-row]",
      );
      const threadId = row?.getAttribute("data-better-sidebar-row");
      if (!threadId) return;
      event.preventDefault();
      setCompleted(threadId, !completedAt.has(threadId));
      return;
    }
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
  }, [setCompleted, completedAt]);

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
    const queryText = typeof searchQuery === "string" ? searchQuery : "";
    const narrowed = queryText.trim() !== "" || scopedProject !== undefined;
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

  return (
    <CompletedActionsProvider setCompleted={setCompleted}>
    <div
      data-better-sidebar-list=""
      // B73.1: the whole panel sits on one 8px column, and the scroll
      // container is what carries it. The rows, the section headers and the
      // project filter each carried their own inset before, which put chrome
      // at 8px and rows at 0 (B73.2).
      className="flex h-full flex-col overflow-y-auto px-2 py-2"
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
              showEffort={settings.showEffort}
              showRelativeTime={settings.showRelativeTime}
              quickActions={{
                pin: settings.showQuickPin,
                markRead: settings.showQuickMarkRead,
                archive: settings.showQuickArchive,
                completed: settings.showQuickCompleted,
              }}
              showSignals={settings.density === "detailed"}
              isCompactViewport={isCompactViewport}
              // The route's own row, child rows included: they come through
              // the same `section.rows` and so through this one call site.
              isActive={row.thread.id === activeThreadId}
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
    </CompletedActionsProvider>
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
  //
  // B86.4 is the one exception: COMPLETED arrives folded, so a header without
  // its number is a closed box the user cannot see into. The rule above still
  // holds everywhere else — `showCount` is true for that key alone.
  const label = (
    <>
      {section.isSubgroup ? (
        section.key.startsWith("working:") ? (
          // The row vocabulary reads working indicators as execution in
          // flight, and the prompt mark says exactly that — distinct, at
          // 12px, from COMPLETED's check beside which it always renders.
          <Glyph
            name="terminal"
            aria-hidden="true"
            className="size-3 shrink-0 opacity-80"
          />
        ) : (
          <Glyph
            name="check"
            aria-hidden="true"
            className="size-3 shrink-0 opacity-80"
          />
        )
      ) : null}
      <span className="min-w-0 truncate text-left">
        {section.label}
        {/* The space is a real text node, not styling: the header's accessible
            name is the concatenation of its text, and a margin alone made the
            collapsed section announce itself as "COMPLETED1". */}
        {section.showCount ? (
          <>
            {" "}
            <span className="tabular-nums opacity-60">{section.count}</span>
          </>
        ) : null}
      </span>
    </>
  );
  // are buttons too — one interactive element inside another is invalid, and
  // a click on the display menu would toggle the section under it.
  const rowClass = cn(
    // `px-1` mirrors the row's own inset (`ROW_INSET_PX`, B74), so a
    // header's label starts on the same x as the leading MARK of every row
    // beneath it — which is where bb's own sidebar puts it.
    "group/section flex w-full items-center gap-1.5 px-1 pb-1 font-medium uppercase tracking-wide",
    "text-muted-foreground",
    // B86.1: a subgroup belongs to the group above it, so it indents under
    // its group's header and sits tight under its group's last row. A full
    // `pt-3` would read as a sibling heading rather than as part of what
    // precedes it.
    section.isSubgroup ? "pl-2 pt-1 text-[10px] italic" : "pt-3 text-[11px]",
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
