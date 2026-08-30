import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useSettings,
  type PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import { cn } from "./lib/utils";
import { parseSettings } from "./settings";
import { buildListModel } from "./model/list-model";
import type { GroupBy, RenderSection, SecondRowMode } from "./model/types";
import { ThreadRow } from "./row/ThreadRow";
import { CompactViewportProvider } from "./dossier/RowHover";
import { Glyph } from "./ui/Glyph";
import { ListEmpty, ListError, ListLoading, ListNoMatches } from "./ui/ListStates";
import { useCollapse } from "./useCollapse";
import { useFreeze } from "./useFreeze";
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
  const settings = parseSettings(useSettings().values);
  const now = useNow();
  const collapse = useCollapse();
  const freeze = useFreeze({
    searchQuery,
    groupBy: settings.groupBy,
    secondRow: settings.secondRow,
  });

  const model = useMemo(
    () =>
      buildListModel({
        threads,
        projects,
        settings,
        searchQuery,
        now,
        frozen: freeze.frozen,
        collapsedSections: collapse.collapsedSections,
        collapsedThreadIds: collapse.collapsedThreadIds,
      }),
    [
      threads,
      projects,
      settings.groupBy,
      settings.secondRow,
      settings.tooltip,
      searchQuery,
      now,
      freeze.frozen,
      collapse.collapsedSections,
      collapse.collapsedThreadIds,
    ],
  );
  // Records the sequence a later freeze pins; a no-op while already frozen.
  freeze.observe(model);

  // B47: the host clears its search field and closes the mobile drawer here, so
  // every open path calls it. Opening also ends the freeze — the pointer's
  // context is about to be navigated away from.
  const handleNavigate = useCallback(() => {
    freeze.release();
    onNavigate();
  }, [freeze, onNavigate]);

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
  if (model.sections.length === 0) {
    return searchQuery.trim() === "" ? <ListEmpty /> : <ListNoMatches query={searchQuery} />;
  }

  const showSecondRow = showsSecondRow(settings.secondRow, settings.groupBy);
  // Rebuilt each render so the jump table cannot outlive the sections it indexes.
  headersRef.current = [];

  return (
    // The dossier reads `isCompactViewport` from this provider: `RowHover`'s
    // signature is fixed at `{threadId, children}`, so without it B32 would be
    // decided by the hook's own media query rather than by the host's prop.
    <CompactViewportProvider isCompactViewport={isCompactViewport}>
      <div
        data-better-sidebar-list=""
        className="flex h-full flex-col overflow-y-auto py-1"
        onPointerEnter={freeze.onPointerEnter}
        onPointerLeave={freeze.onPointerLeave}
        onKeyDown={onKeyDown}
      >
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
                showSecondRow={showSecondRow}
                isCompactViewport={isCompactViewport}
                onNavigate={handleNavigate}
                isSubtreeCollapsed={collapse.collapsedThreadIds.has(row.thread.id)}
                onToggleSubtree={
                  row.childCount > 0 ? () => collapse.toggleThread(row.thread.id) : undefined
                }
              />
            ))}
          </section>
        ))}
      </div>
    </CompactViewportProvider>
  );
}

/**
 * B18: `auto` means "row 2 unless the grouping already says it". Grouping by
 * project puts the project name in the header, so repeating it under every
 * title is noise; `always` and `never` are the user overriding that judgement.
 */
function showsSecondRow(mode: SecondRowMode, groupBy: GroupBy): boolean {
  if (mode === "always") return true;
  if (mode === "never") return false;
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
  const label = (
    <>
      <span className="truncate">{section.label}</span>
      <span className="tabular-nums text-muted-foreground/70">{section.count}</span>
    </>
  );
  const className = cn(
    "flex w-full items-center gap-1.5 px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-wide",
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

/** B41: the gradient reaches section headers, never a row-1 title. */
function dimClassFor(section: RenderSection): string {
  const dimLevel = section.rows[0]?.dimLevel ?? 0;
  return ["", "opacity-90", "opacity-80", "opacity-70"][dimLevel] ?? "";
}
