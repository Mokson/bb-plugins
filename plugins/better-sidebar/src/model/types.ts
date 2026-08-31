import type {
  PluginSidebarProject,
  PluginSidebarThread,
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
  showProviderGlyph: boolean;
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

export type SectionKey =
  | "needs-you"
  | "done"
  | "pinned"
  | DateBucketKey
  | `project:${string}`
  | `host:${string}`
  | `status:${StatusGroupKey}`
  | "all"
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
