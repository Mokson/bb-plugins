import type {
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";

export type GroupBy = "date" | "project" | "none";
export type SecondRowMode = "auto" | "always" | "never";
export type TooltipMode = "rich" | "minimal" | "off";

export interface BetterSidebarSettings {
  groupBy: GroupBy;
  secondRow: SecondRowMode;
  tooltip: TooltipMode;
}

export type DateBucketKey = "today" | "yesterday" | "last-7" | "last-30" | "older";

export type SectionKey =
  | "needs-you"
  | "pinned"
  | DateBucketKey
  | `project:${string}`
  | "all"
  | "search";

/** The snapshot B6 pins the rendered order to. Plain data, so the model stays pure. */
export interface FrozenOrder {
  /**
   * The WHOLE rendered sequence at the instant of the freeze, in visual order —
   * every row of every section, flattened. Freezing per section would let a
   * growing top section shift every row below it; freezing the sequence cannot.
   */
  readonly ids: readonly string[];
  /** The section each frozen id was in; a frozen row never changes section. */
  readonly sectionOf: Readonly<Record<string, SectionKey>>;
  /** Section order at the instant of the freeze; sections do not reorder either. */
  readonly sectionOrder: readonly SectionKey[];
}

export interface ListModelInput {
  readonly threads: readonly PluginSidebarThread[];
  readonly projects: readonly PluginSidebarProject[];
  readonly settings: BetterSidebarSettings;
  readonly searchQuery: string;
  /** Epoch ms, quantized by the caller so the model is stable across renders. */
  readonly now: number;
  readonly frozen: FrozenOrder | null;
  readonly collapsedSections: ReadonlySet<SectionKey>;
  readonly collapsedThreadIds: ReadonlySet<string>;
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
