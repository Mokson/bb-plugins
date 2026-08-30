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

/** B13: `title ?? titleFallback ?? "Untitled"`, whitespace-only counting as absent. */
export function resolveTitle(thread: PluginSidebarThread): string {
  const title = thread.title?.trim();
  if (title) return title;
  const fallback = thread.titleFallback?.trim();
  if (fallback) return fallback;
  return "Untitled";
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
  const childrenOf = new Map<string, PluginSidebarThread[]>();
  const roots: PluginSidebarThread[] = [];
  for (const thread of visible) {
    // B9: a thread whose parent is not visible is its own root, so orphans stay
    // reachable rather than disappearing with their parent.
    const parentId =
      thread.parentThreadId && byId.has(thread.parentThreadId)
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

/** Every visible thread in the subtree, collapse notwithstanding (B7's count). */
function subtreeSize(root: PluginSidebarThread, tree: Tree): number {
  let total = 1;
  for (const child of tree.childrenOf.get(root.id) ?? []) {
    total += subtreeSize(child, tree);
  }
  return total;
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
    countBySection.set(key, (countBySection.get(key) ?? 0) + subtreeSize(root, tree));
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
 * Step 7 of §3 / §4: the overlay pins the WHOLE flattened sequence, not one
 * section at a time, so nothing the pointer is aiming at can move.
 */
function applyFreeze(
  live: readonly RenderSection[],
  input: ListModelInput,
  projectNames: ReadonlyMap<string, string>,
): RenderSection[] {
  const frozen = input.frozen!;
  const liveRows = new Map<string, RenderRow>();
  for (const section of live) {
    for (const row of section.rows) liveRows.set(row.thread.id, row);
  }

  const rowsBySection = new Map<SectionKey, RenderRow[]>();
  const claimed = new Set<string>();
  const order: SectionKey[] = [...frozen.sectionOrder];
  for (const id of frozen.ids) {
    const row = liveRows.get(id);
    if (!row) continue; // deleted, archived or filtered out: survivors close the gap
    const key = frozen.sectionOf[id] ?? row.sectionKey;
    if (!order.includes(key)) order.push(key);
    const pinned: RenderRow = { ...row, sectionKey: key, dimLevel: dimLevelFor(key) };
    const rows = rowsBySection.get(key);
    if (rows) rows.push(pinned);
    else rowsBySection.set(key, [pinned]);
    claimed.add(id);
  }

  const sections: RenderSection[] = [];
  for (const key of order) {
    const rows = rowsBySection.get(key) ?? [];
    if (rows.length === 0) continue; // B4 still holds while frozen
    sections.push(makeSection(key, rows, rows.length, input, projectNames));
  }

  // §4 point 4: a thread that arrived while frozen renders immediately at the very
  // end of the entire list, in arrival order, with no section header of its own.
  const newcomers: RenderRow[] = [];
  for (const thread of input.threads) {
    if (claimed.has(thread.id)) continue;
    const row = liveRows.get(thread.id);
    if (row) newcomers.push(row);
  }
  if (newcomers.length === 0) return sections;

  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const host = sections[index]!;
    if (host.isCollapsed) continue;
    sections[index] = {
      ...host,
      count: host.count + newcomers.length,
      rows: [...host.rows, ...newcomers],
    };
    return sections;
  }
  // Nothing frozen survives to append to: fall back to the newcomers' live sections.
  const keys = new Set(newcomers.map((row) => row.sectionKey));
  for (const section of live) {
    if (!keys.has(section.key)) continue;
    sections.push(section);
  }
  return sections;
}

export function buildListModel(input: ListModelInput): ListModel {
  const tree = buildTree(input);
  const projectNames = projectNameMap(input);
  const live =
    input.searchQuery.trim() === ""
      ? buildLiveSections(tree, input, projectNames)
      : buildSearchSections(tree, input, projectNames);
  const sections = input.frozen ? applyFreeze(live, input, projectNames) : live;
  let rowCount = 0;
  for (const section of sections) rowCount += section.rows.length;
  return { sections, rowCount };
}
