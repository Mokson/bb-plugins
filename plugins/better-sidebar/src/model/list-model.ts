import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  DATE_BUCKET_ORDER,
  bucketOf,
  dimLevelFor,
  isCollapsibleSection,
  labelFor,
} from "./buckets";
import { rankSearch, type SearchCandidate } from "./search";
import type {
  ListModel,
  ListModelInput,
  RenderRow,
  RenderSection,
  SectionKey,
} from "./types";

/**
 * B13: `title ?? titleFallback ?? "Untitled"`. The chain is **nullish**, not
 * truthy: a thread that carries a title only ever shows that title, so a
 * whitespace-only `"   "` renders as `"Untitled"` rather than borrowing the
 * fallback of a thread the host already considers named.
 */
export function resolveTitle(thread: PluginSidebarThread): string {
  const chosen = thread.title ?? thread.titleFallback ?? "";
  const trimmed = chosen.trim();
  return trimmed === "" ? "Untitled" : trimmed;
}

const WORKTREE_KINDS = new Set(["managed-worktree", "unmanaged-worktree"]);

/**
 * B16 as re-worded in §7: `environment.branchName` → `environment.name` when the
 * workspace is a worktree → `host.name` → null, and the whole chain is skipped
 * when `environment` is null.
 */
export function resolveWorkspaceLabel(thread: PluginSidebarThread): string | null {
  const environment = thread.environment;
  if (!environment) return null;
  const branch = environment.branchName?.trim();
  if (branch) return branch;
  if (WORKTREE_KINDS.has(environment.workspaceDisplayKind)) {
    const name = environment.name?.trim();
    if (name) return name;
  }
  const host = thread.host?.name.trim();
  return host ? host : null;
}

/** Descending `latestAttentionAt`, `id` breaking ties so the order is total (B5). */
function byAttention(a: PluginSidebarThread, b: PluginSidebarThread): number {
  if (a.latestAttentionAt !== b.latestAttentionAt) {
    return b.latestAttentionAt - a.latestAttentionAt;
  }
  return a.id < b.id ? -1 : 1;
}

interface Tree {
  readonly visible: readonly PluginSidebarThread[];
  readonly byId: ReadonlyMap<string, PluginSidebarThread>;
  readonly childrenOf: ReadonlyMap<string, PluginSidebarThread[]>;
  readonly roots: readonly PluginSidebarThread[];
}

/**
 * B11: an archived thread is visible only while every ancestor up to its root is
 * present and expanded. Non-archived threads are always in the visible set;
 * collapse prunes them at render time, not here.
 */
function buildTree(input: ListModelInput): Tree {
  const present = new Map(input.threads.map((thread) => [thread.id, thread]));
  const decided = new Map<string, boolean>();

  const isVisible = (thread: PluginSidebarThread, seen: Set<string>): boolean => {
    const cached = decided.get(thread.id);
    if (cached !== undefined) return cached;
    if (seen.has(thread.id)) return false; // a parent cycle is not a crash
    seen.add(thread.id);
    let result = true;
    if (thread.isArchived) {
      const parent = thread.parentThreadId
        ? present.get(thread.parentThreadId)
        : undefined;
      result =
        parent !== undefined &&
        !input.collapsedThreadIds.has(parent.id) &&
        isVisible(parent, seen);
    }
    decided.set(thread.id, result);
    return result;
  };

  const visible = input.threads.filter((thread) => isVisible(thread, new Set()));
  const byId = new Map(visible.map((thread) => [thread.id, thread]));

  /**
   * B1: a `parentThreadId` cycle (`A→B`, `B→A`) would leave every member of the
   * cycle unreachable from `roots`, and the whole ring would vanish from the
   * list. The rule: **a thread that can reach itself by walking parents has no
   * reachable visible root, so it is treated as a root.** Every cycle member
   * qualifies, so every one of them renders exactly once, and the edges that
   * survive into `childrenOf` are acyclic by construction.
   */
  const isOnParentCycle = (thread: PluginSidebarThread): boolean => {
    const seen = new Set<string>([thread.id]);
    let parentId = thread.parentThreadId;
    while (parentId) {
      if (parentId === thread.id) return true;
      if (seen.has(parentId)) return false; // a ring the thread is not part of
      seen.add(parentId);
      parentId = byId.get(parentId)?.parentThreadId ?? null;
    }
    return false;
  };

  const childrenOf = new Map<string, PluginSidebarThread[]>();
  const roots: PluginSidebarThread[] = [];
  for (const thread of visible) {
    // B9: a thread whose parent is not visible is its own root, so orphans stay
    // reachable rather than disappearing with their parent.
    const parentId =
      thread.parentThreadId &&
      byId.has(thread.parentThreadId) &&
      !isOnParentCycle(thread)
        ? thread.parentThreadId
        : null;
    if (parentId === null) {
      roots.push(thread);
      continue;
    }
    const siblings = childrenOf.get(parentId);
    if (siblings) siblings.push(thread);
    else childrenOf.set(parentId, [thread]);
  }
  for (const siblings of childrenOf.values()) siblings.sort(byAttention);
  roots.sort(byAttention);
  return { visible, byId, childrenOf, roots };
}

/**
 * Step 4 of §3. One write per root into a single map, so a thread satisfying two
 * predicates cannot land in two sections (B1).
 */
function assignSections(
  roots: readonly PluginSidebarThread[],
  input: ListModelInput,
): Map<string, SectionKey> {
  const assignment = new Map<string, SectionKey>();
  for (const root of roots) {
    let key: SectionKey;
    if (root.hasPendingInteraction) key = "needs-you";
    else if (root.isPinned) key = "pinned";
    else if (input.settings.groupBy === "date") {
      key = bucketOf(root.latestAttentionAt, input.now);
    } else if (input.settings.groupBy === "project") {
      key = `project:${root.projectId}`;
    } else key = "all";
    assignment.set(root.id, key);
  }
  return assignment;
}

function projectNameMap(input: ListModelInput): Map<string, string> {
  return new Map(input.projects.map((project) => [project.id, project.name]));
}

function makeRow(
  thread: PluginSidebarThread,
  tree: Tree,
  sectionKey: SectionKey,
  depth: number,
  projectNames: ReadonlyMap<string, string>,
  projectNameFallback: string | null = null,
): RenderRow {
  return {
    thread,
    title: resolveTitle(thread),
    workspaceLabel: resolveWorkspaceLabel(thread),
    depth,
    childCount: tree.childrenOf.get(thread.id)?.length ?? 0,
    projectName: projectNames.get(thread.projectId) ?? projectNameFallback,
    dimLevel: dimLevelFor(sectionKey),
    sectionKey,
  };
}

/** Pre-order walk, stopping at collapsed parents (step 6 of §3). */
function flattenSubtree(
  root: PluginSidebarThread,
  tree: Tree,
  input: ListModelInput,
  sectionKey: SectionKey,
  projectNames: ReadonlyMap<string, string>,
  out: RenderRow[],
  depth = 0,
): void {
  out.push(makeRow(root, tree, sectionKey, depth, projectNames));
  if (input.collapsedThreadIds.has(root.id)) return;
  for (const child of tree.childrenOf.get(root.id) ?? []) {
    flattenSubtree(child, tree, input, sectionKey, projectNames, out, depth + 1);
  }
}

function sectionOrderFor(
  input: ListModelInput,
  present: ReadonlySet<SectionKey>,
): SectionKey[] {
  const order: SectionKey[] = ["needs-you", "pinned"];
  if (input.settings.groupBy === "date") order.push(...DATE_BUCKET_ORDER);
  else if (input.settings.groupBy === "none") order.push("all");
  else {
    // B8: project sections follow the host's project order.
    for (const project of input.projects) order.push(`project:${project.id}`);
    for (const key of present) if (!order.includes(key)) order.push(key);
  }
  return order;
}

function makeSection(
  key: SectionKey,
  rows: readonly RenderRow[],
  count: number,
  input: ListModelInput,
  projectNames: ReadonlyMap<string, string>,
): RenderSection {
  const isCollapsible = isCollapsibleSection(key);
  const isCollapsed = isCollapsible && input.collapsedSections.has(key);
  return {
    key,
    label: labelFor(key, projectNames),
    count,
    isCollapsible,
    isCollapsed,
    rows: isCollapsed ? [] : rows,
  };
}

/** Step 2 of §3: search suspends all grouping (B43). */
function buildSearchSections(
  tree: Tree,
  input: ListModelInput,
  projectNames: ReadonlyMap<string, string>,
): RenderSection[] {
  const candidates: SearchCandidate[] = tree.visible.map((thread) => ({
    thread,
    title: resolveTitle(thread),
    projectName: projectNames.get(thread.projectId) ?? thread.projectId,
  }));
  const rows = rankSearch(candidates, input.searchQuery).map((candidate) =>
    makeRow(candidate.thread, tree, "search", 0, projectNames, candidate.projectName),
  );
  if (rows.length === 0) return [];
  return [makeSection("search", rows, rows.length, input, projectNames)];
}

function buildLiveSections(
  tree: Tree,
  input: ListModelInput,
  projectNames: ReadonlyMap<string, string>,
): RenderSection[] {
  const assignment = assignSections(tree.roots, input);
  const rowsBySection = new Map<SectionKey, RenderRow[]>();
  const countBySection = new Map<SectionKey, number>();
  for (const root of tree.roots) {
    const key = assignment.get(root.id)!;
    let rows = rowsBySection.get(key);
    if (!rows) rowsBySection.set(key, (rows = []));
    flattenSubtree(root, tree, input, key, projectNames, rows);
    // B53.4: root rows only, never nested children. Counting the whole subtree
    // made the number churn continuously as subagents spawned and finished,
    // while nothing the user put in the section had changed. Root-only is also
    // what makes the count invariant under expanding a subtree (B53.5) —
    // collapse state cannot touch a number that never counted children.
    countBySection.set(key, (countBySection.get(key) ?? 0) + 1);
  }
  const order = sectionOrderFor(input, new Set(rowsBySection.keys()));
  const sections: RenderSection[] = [];
  for (const key of order) {
    const count = countBySection.get(key) ?? 0;
    if (count === 0) continue; // B4: an empty section renders nothing at all
    sections.push(
      makeSection(key, rowsBySection.get(key) ?? [], count, input, projectNames),
    );
  }
  return sections;
}

/**
 * A root row together with the visible subtree rendered beneath it, exactly as
 * the live model laid it out.
 *
 * This is the unit the freeze orders, and it is what makes the overlay correct
 * by construction rather than by enumerated cases. A child is never ordered
 * independently of its parent, so a subtree expanded while frozen cannot be
 * mistaken for a set of newly arrived threads — the situation that let expanding
 * a node scatter its children to the bottom of the list.
 */
interface RootGroup {
  readonly rootId: string;
  readonly rows: readonly RenderRow[];
}

/** Splits a section's pre-order rows back into root subtrees, on `depth === 0`. */
function groupRoots(rows: readonly RenderRow[]): RootGroup[] {
  const groups: { rootId: string; rows: RenderRow[] }[] = [];
  for (const row of rows) {
    const current = groups[groups.length - 1];
    if (row.depth === 0 || current === undefined) {
      groups.push({ rootId: row.thread.id, rows: [row] });
    } else {
      current.rows.push(row);
    }
  }
  return groups;
}

/** Re-homes a row into the section it is actually rendered in. */
function inSection(row: RenderRow, key: SectionKey): RenderRow {
  if (row.sectionKey === key) return row;
  return { ...row, sectionKey: key, dimLevel: dimLevelFor(key) };
}

/**
 * Step 7 of §3 / §4 — the overlay.
 *
 * **Everything structural comes from the live model**: which sections exist,
 * their headers, labels, counts, collapsibility and collapse state, and the
 * parent/child nesting inside every root subtree. The snapshot contributes one
 * thing only — the ORDER of the root subtrees within the whole rendered
 * sequence, plus which section each already-rendered root sits in.
 *
 * That split is the invariant: because the overlay never rebuilds structure, no
 * structural change made while the pointer is over the list (expanding a
 * subtree, collapsing a section, a bucket re-partition) can be misread as a
 * reordering. It simply renders, in the position the snapshot already fixed.
 */
function applyFreeze(
  live: readonly RenderSection[],
  input: ListModelInput,
): RenderSection[] {
  const frozen = input.frozen!;
  const rankOf = new Map(frozen.ids.map((id, index) => [id, index]));
  const liveByKey = new Map(live.map((section) => [section.key, section]));
  const arrivalOf = new Map(input.threads.map((thread, index) => [thread.id, index]));

  const known: { group: RootGroup; key: SectionKey; rank: number }[] = [];
  const newcomers: RootGroup[] = [];
  for (const section of live) {
    for (const group of groupRoots(section.rows)) {
      const rank = rankOf.get(group.rootId);
      if (rank === undefined) {
        newcomers.push(group);
        continue;
      }
      // A frozen row never changes section, but only into a section the LIVE
      // model still renders; otherwise it stays where the live model put it.
      const frozenKey = frozen.sectionOf[group.rootId];
      const key =
        frozenKey !== undefined && liveByKey.has(frozenKey) ? frozenKey : section.key;
      known.push({ group, key, rank });
    }
  }

  // Nothing pinned survives, so there is no order left to preserve. Releasing
  // the freeze is the whole answer — a hybrid of live and frozen order is not.
  if (known.length === 0) return [...live];

  const rowsByKey = new Map<SectionKey, RenderRow[]>();
  for (const entry of known.sort((a, b) => a.rank - b.rank)) {
    let rows = rowsByKey.get(entry.key);
    if (!rows) rowsByKey.set(entry.key, (rows = []));
    for (const row of entry.group.rows) rows.push(inSection(row, entry.key));
  }

  // §4 point 1: sections present at freeze time keep their relative order; a
  // section the live model has since introduced is appended after them, where
  // it cannot push an already-rendered row down.
  const order: SectionKey[] = frozen.sectionOrder.filter((key) => liveByKey.has(key));
  for (const section of live) if (!order.includes(section.key)) order.push(section.key);

  const sections: RenderSection[] = [];
  for (const key of order) {
    const section = liveByKey.get(key)!;
    const rows = section.isCollapsed ? [] : (rowsByKey.get(key) ?? []);
    // B4 holds while frozen too, but a collapsed section is present by right:
    // it has a live count to show even though it renders no rows.
    if (rows.length === 0 && !section.isCollapsed) continue;
    sections.push({ ...section, rows });
  }

  if (newcomers.length === 0) return sections;

  // §4 point 4: a thread that genuinely arrived while frozen renders at the very
  // end of the ENTIRE list, in arrival order — the only position that provably
  // moves nothing above it. It gets no section header of its own.
  newcomers.sort(
    (a, b) => (arrivalOf.get(a.rootId) ?? 0) - (arrivalOf.get(b.rootId) ?? 0),
  );
  let hostIndex = sections.length - 1;
  while (hostIndex >= 0 && sections[hostIndex]!.isCollapsed) hostIndex -= 1;
  if (hostIndex === -1) return [...live]; // nowhere to append: release instead

  const host = sections[hostIndex]!;
  const appended = newcomers.flatMap((group) =>
    group.rows.map((row) => inSection(row, host.key)),
  );
  sections[hostIndex] = {
    ...host,
    // B53.4 again: one per newcomer ROOT, not one per appended row.
    count: host.count + newcomers.length,
    rows: [...host.rows, ...appended],
  };
  return sections;
}

export function buildListModel(input: ListModelInput): ListModel {
  const tree = buildTree(input);
  const projectNames = projectNameMap(input);
  const live =
    input.searchQuery.trim() === ""
      ? buildLiveSections(tree, input, projectNames)
      : buildSearchSections(tree, input, projectNames);
  const sections = input.frozen ? applyFreeze(live, input) : live;
  let rowCount = 0;
  for (const section of sections) rowCount += section.rows.length;
  return { sections, rowCount };
}
