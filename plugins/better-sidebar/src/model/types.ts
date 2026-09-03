import type {
  PluginSidebarProject,
  PluginSidebarThread,
  PluginSidebarThreadIndicator,
} from "@get-bb/plugin-sdk/app";

/** B65: `host` and `status` join the modes an unknown value degrades to `date`. */
export type GroupBy = "date" | "project" | "host" | "status" | "none";
/** B60: one axis for row 2, the hover card and the signal glyphs. */
export type Density = "compact" | "default" | "detailed";

/** The settings, all server-backed through `bb.settings.define` (B59). */
export interface BetterSidebarSettings {
  groupBy: GroupBy;
  density: Density;
  showPrChip: boolean;
  showRelativeTime: boolean;
  /** B11: archived children under an expanded parent. */
  showArchivedChildren: boolean;
  /** B58: the child-threads chip in bb's thread header. */
  showHeaderChip: boolean;
  /**
   * A hard off-switch for row 2. With it on, `density` and the grouping mode
   * still decide (B60): `compact` draws none, and grouping by project already
   * says the project.
   */
  showSecondRow: boolean;
  /** Row 2's project name. Redundant when the grouping or scope already says it. */
  showProjectName: boolean;
  /** Row 2's git branch — the longest label on the line, and the one that truncates. */
  showBranch: boolean;
  /**
   * Row 2's model and effort. The only field on the line that costs a backend
   * lookup, so it is the only one whose toggle also switches off a request.
   */
  showModel: boolean;
  /** B84: row 2's effort, the half of the model label after the dot. */
  showEffort: boolean;
  /** B85: the row's hover quick actions. Pin replaces mark-read as the
   * default first action; the read toggle stays reachable from the menus. */
  showQuickPin: boolean;
  showQuickMarkRead: boolean;
  showQuickArchive: boolean;
}

export type DateBucketKey = "today" | "yesterday" | "last-7" | "last-30" | "older";

/**
 * B65.4: the five-state row vocabulary, plus the `unread` state the same glyph
 * table already carries and B67.7 merges DONE into. It is the vocabulary the
 * row draws — a second status language is what B65.4 forbids.
 */
export type StatusGroupKey =
  | "needs-you"
  | "unread"
  | "working"
  | "planning"
  | "draft"
  | "idle";

/** B65.2: the `host:` section a thread with no `host` lands in. */
export const NO_HOST_KEY = "host:none";

/**
 * What the current grouping mode splits threads into, before any band applies.
 *
 * Split out from `SectionKey` because B86.1 nests: a COMPLETED subgroup exists
 * per GROUP, so its key has to embed one, and `completed:completed:x` must not
 * be constructible.
 */
export type GroupKey =
  | DateBucketKey
  | `project:${string}`
  | `host:${string}`
  | `status:${StatusGroupKey}`
  | "all";

export type SectionKey =
  | "needs-you"
  | "done"
  | "pinned"
  /** B86.1: the filed threads of one group, rendered under it. */
  | `completed:${GroupKey}`
  | GroupKey
  | "search";

/** One thread's place in the section it currently occupies (B68.1). */
export interface SectionOrderEntry {
  readonly section: SectionKey;
  /** Monotonic. A higher sequence entered later, and B68.2 renders it first. */
  readonly sequence: number;
}

/**
 * The entrance-order map (B68). Session state, owned by `useSectionOrder`.
 *
 * It decides only WHERE WITHIN a section a thread sits. Which section a thread
 * is in is the live model's answer, always — the deleted freeze overlay shipped
 * a blocker precisely by rebuilding sections out of a row-only snapshot.
 */
export interface SectionOrder {
  readonly entries: ReadonlyMap<string, SectionOrderEntry>;
  readonly nextSequence: number;
}

export interface ListModelInput {
  readonly threads: readonly PluginSidebarThread[];
  readonly projects: readonly PluginSidebarProject[];
  readonly settings: BetterSidebarSettings;
  readonly searchQuery: string;
  /** Epoch ms, quantized by the caller so the model is stable across renders. */
  readonly now: number;
  /**
   * B64: project scope. `null` is "All projects". Presentation only — it is
   * applied here and never fed to the entrance-order reconciler (B68.5).
   */
  readonly projectFilter: string | null;
  /** B68. `null` falls back to `latestAttentionAt` order, the B68.3 seed. */
  readonly sectionOrder: SectionOrder | null;
  /**
   * The machine bb runs on. A row whose host matches drops the host name from
   * its workspace label (B16's last resort). `null` while the lookup is in
   * flight, or when it failed — every row keeps its label.
   */
  readonly localHostId: string | null;
  readonly collapsedSections: ReadonlySet<SectionKey>;
  /**
   * B86: the threads the user has marked completed, mapped to the epoch ms they
   * were marked at. Owned by `useCompleted`; the model only reads it.
   *
   * The timestamp is not decoration. It orders the COMPLETED section, and the
   * row's "moved on since you filed it" dot is `updatedAt` measured against it.
   */
  readonly completedAt: ReadonlyMap<string, number>;
  /**
   * B10, inverted: the parents the user has OPENED. A parent with children is
   * collapsed until it appears here.
   */
  readonly expandedThreadIds: ReadonlySet<string>;
}

export interface RenderRow {
  readonly thread: PluginSidebarThread;
  /** B13, resolved here: `title ?? titleFallback ?? "Untitled"`, already trimmed. */
  readonly title: string;
  /** B16, resolved here per the §7 ruling; null when nothing in the chain applies. */
  readonly workspaceLabel: string | null;
  /** 0 for a root row; +1 per parent hop. Drives the B9 indent. */
  readonly depth: number;
  /** Direct children of this row that exist in `threads`; drives the B10 chevron. */
  readonly childCount: number;
  /** Project name for the B43 flat list and the B15 metadata line; null when unknown. */
  readonly projectName: string | null;
  /** B41. 0 = full opacity, rising with bucket age, capped at DIM_FLOOR. */
  readonly dimLevel: 0 | 1 | 2 | 3;
  readonly sectionKey: SectionKey;
  /**
   * B86: the user has filed this thread. True wherever the row is drawn, the
   * search list included — search suspends grouping, so the section key is the
   * one place that would otherwise say so, and there it says `search`.
   */
  readonly isCompleted: boolean;
  /**
   * B86: the thread has been written to since it was filed. Drawn as a dot in
   * the COMPLETED section, because a thread that resumed work is the one entry
   * in that pile worth looking at.
   *
   * False for every row that is not completed.
   */
  readonly hasUpdateSinceCompleted: boolean;
  /**
   * B87: the state this row draws ON BEHALF OF its descendants, or null when it
   * has none to draw. Set only for a thread whose own indicator is `none`, so
   * it never contradicts the thread's own state.
   *
   * Presentation only. The section key, the bands and the sort all still read
   * the thread's own indicator, so a parent never migrates between sections
   * because a child started or stopped.
   */
  readonly rolledUpIndicator: PluginSidebarThreadIndicator | null;
}

export interface RenderSection {
  readonly key: SectionKey;
  readonly label: string;
  /**
   * B53.4: ROOT rows in the section, never nested children, expanded or not.
   * A subagent is not a thread the user started, and counting them made the
   * number churn while the section's own contents were unchanged.
   */
  readonly count: number;
  /**
   * Whether the header draws `count`. False everywhere but COMPLETED (B86.4):
   * that section is collapsed by default, so a header with no number is a box
   * whose contents the user cannot see without opening it. Every other section
   * either cannot be collapsed or answers a question the row's own time
   * already answers.
   */
  readonly showCount: boolean;
  /**
   * B86.1: this section is a COMPLETED subgroup of the section above it, and
   * the header draws indented to say so.
   */
  readonly isSubgroup: boolean;
  readonly isCollapsible: boolean;
  readonly isCollapsed: boolean;
  /** Pre-order flat: parent immediately followed by its visible subtree. */
  readonly rows: readonly RenderRow[];
}

export interface ListModel {
  readonly sections: readonly RenderSection[];
  /** Sum of `rows.length` over expanded sections. Every one of them is mounted. */
  readonly rowCount: number;
}
