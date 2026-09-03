import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import {
  DATE_BUCKET_ORDER,
  STATUS_GROUP_ORDER,
  bucketOf,
  dimLevelFor,
  isCollapsedByDefault,
  isCollapsibleSection,
  labelFor,
  showsCount,
  statusGroupOf,
} from "./buckets";
import { rankSearch, type SearchCandidate } from "./search";
import {
  NO_HOST_KEY,
  type BetterSidebarSettings,
  type ListModel,
  type ListModelInput,
  type RenderRow,
  type RenderSection,
  type SectionKey,
  type SectionOrder,
} from "./types";

/**
 * B13: `title ?? titleFallback ?? "Untitled"`. The chain is **nullish**, not
 * truthy: a thread that carries a title only ever shows that title, so a
 * whitespace-only `"   "` renders as `"Untitled"` rather than borrowing the
 * fallback of a thread the host already considers named.
 */
export function resolveTitle(thread: PluginSidebarThread): string {
  const raw = thread.title ?? thread.titleFallback ?? "";
  const chosen = typeof raw === "string" ? raw : "";
  const trimmed = chosen.trim();
  return trimmed === "" ? "Untitled" : trimmed;
}

const WORKTREE_KINDS = new Set(["managed-worktree", "unmanaged-worktree"]);

/**
 * B16 as re-worded in §7: `environment.branchName` → `environment.name` when the
 * workspace is a worktree → `host.name` → null, and the whole chain is skipped
 * when `environment` is null.
 *
 * `localHostId` cuts the chain one step short: the machine is the LAST resort,
 * and it only says something when the work runs elsewhere. On the current
 * machine it is the same word on every row, so the row draws nothing instead.
 */
export function resolveWorkspaceLabel(
  thread: PluginSidebarThread,
  localHostId: string | null,
): string | null {
  const workspace = resolveWorkspaceOnly(thread);
  if (workspace !== null) return workspace;
  if (!reachesHostStep(thread)) return null;
  if (thread.host === null || thread.host.id === localHostId) return null;
  const host = typeof thread.host.name === "string" ? thread.host.name.trim() : "";
  return host ? host : null;
}

/**
 * True when this thread's label chain would fall through to its machine name.
 *
 * B61: the current machine's id costs one request, so it is fetched only when
 * some thread could actually spend it. A list where every thread has a branch
 * — or one drawing no second row at all — asks the backend nothing.
 *
 * Defined as the chain itself running out, rather than as its own copy of the
 * branch and worktree tests: two copies of one fall-through drift the moment
 * B16 gains a step.
 */
export function usesHostLabel(thread: PluginSidebarThread): boolean {
  return thread.host !== null && reachesHostStep(thread);
}

/**
 * True when B16's chain runs past every workspace step and arrives at the
 * machine name. A thread with no `environment` never gets there: B16 skips the
 * WHOLE chain in that case, machine included.
 */
function reachesHostStep(thread: PluginSidebarThread): boolean {
  return Boolean(thread.environment) && resolveWorkspaceOnly(thread) === null;
}

/** B16's chain up to but not including the machine name. */
function resolveWorkspaceOnly(thread: PluginSidebarThread): string | null {
  const environment = thread.environment;
  if (!environment) return null;
  const branch =
    typeof environment.branchName === "string" ? environment.branchName.trim() : "";
  if (branch) return branch;
  if (WORKTREE_KINDS.has(environment.workspaceDisplayKind)) {
    const name = typeof environment.name === "string" ? environment.name.trim() : "";
    if (name) return name;
  }
  return null;
}

/** Descending `latestAttentionAt`, `id` breaking ties so the order is total (B5). */
function byAttention(a: PluginSidebarThread, b: PluginSidebarThread): number {
  if (a.latestAttentionAt !== b.latestAttentionAt) {
    return b.latestAttentionAt - a.latestAttentionAt;
  }
  return a.id < b.id ? -1 : 1;
}

/**
 * The default for `sectionKeyOf`'s completion set.
 *
 * `useSectionOrder` and the tests call the predicate with three arguments, and
 * a thread nobody has filed is the overwhelming majority case; a shared frozen
 * empty set keeps those call sites from each allocating one.
 */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/** B67.1: the host's own rolled-up "finished, and you have not looked" state. */
export function isFinished(thread: PluginSidebarThread): boolean {
  return thread.indicator === "unread-success" || thread.indicator === "unread-error";
}

/**
 * B1 precedence, extended by B67 — the ONE place a thread's section is decided.
 *
 * `useSectionOrder` calls this over the unfiltered set (B68.5) and the model
 * calls it over the roots it renders, so the entrance-order map and the
 * rendered structure can never disagree about which section a thread is in.
 *
 * B65.9: `host` and `status` add section KEYS here and nothing else. The three
 * band predicates and their order are identical in every mode; in `status` mode
 * the two bands resolve to their own status group instead of a floating band
 * (B65.5, B67.7), which is a different key for the same decision.
 */
export function sectionKeyOf(
  thread: PluginSidebarThread,
  settings: BetterSidebarSettings,
  now: number,
  completedIds: ReadonlySet<string> = EMPTY_IDS,
): SectionKey {
  const merged = settings.groupBy === "status";
  if (thread.hasPendingInteraction) return merged ? "status:needs-you" : "needs-you";
  // B86.1: COMPLETED outranks every band but NEEDS YOU, and it is flat in every
  // grouping mode — `status` included. Splitting the pile back across the modes
  // would re-scatter the one thing the band exists to gather.
  //
  // It sits UNDER the pending-interaction test on purpose: a filed thread that
  // blocks on the user is not filed any more, and `useCompleted` clears its
  // flag on the same signal (B86.2). The band only has to agree with that while
  // the write is in flight.
  if (completedIds.has(thread.id)) return "completed";
  if (isFinished(thread)) return merged ? "status:unread" : "done";
  if (thread.isPinned) return "pinned";
  switch (settings.groupBy) {
    case "date":
      return bucketOf(thread.latestAttentionAt, now);
    case "project":
      return `project:${thread.projectId}`;
    case "host":
      return thread.host ? `host:${thread.host.id}` : NO_HOST_KEY;
    case "status":
      return `status:${statusGroupOf(thread)}`;
    default:
      return "all";
  }
}

/**
 * B68.2: a thread's entrance sequence, higher meaning "entered later", which
 * renders first.
 *
 * A thread with no entry falls back to `latestAttentionAt`, which covers both
 * cases the fallback has. With no map at all every thread uses it, so the model
 * renders the B5 order the hook seeds from. With a map that has not yet seen
 * this thread, the epoch dwarfs every real sequence and the thread renders at
 * the top of its section — which is what a thread nobody has recorded entering
 * is: an arrival.
 */
function sequenceOf(
  thread: PluginSidebarThread,
  order: SectionOrder | null,
): number {
  return order?.entries.get(thread.id)?.sequence ?? thread.latestAttentionAt;
}

/**
 * B68.2 ordering: newest entrant first, `id` making the order total.
 *
 * Applied to ROOTS only. B9/B69 keep a subtree together and its children on
 * `latestAttentionAt`, so a descendant is never sequenced independently.
 */
function byEntrance(order: SectionOrder | null) {
  return (a: PluginSidebarThread, b: PluginSidebarThread): number => {
    const delta = sequenceOf(b, order) - sequenceOf(a, order);
    if (delta !== 0) return delta;
    return a.id < b.id ? -1 : 1;
  };
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
  // B64.6: the scope removes threads from every section; it changes nothing
  // about precedence, and it is deliberately applied AFTER the entrance-order
  // reconciler has already seen the unfiltered set (B68.5).
  const scoped =
    input.projectFilter === null
      ? input.threads
      : input.threads.filter((thread) => thread.projectId === input.projectFilter);
  const present = new Map(scoped.map((thread) => [thread.id, thread]));
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
      // B59: `showArchivedChildren: false` drops the archived child from the
      // model, so its row is never built rather than built and hidden.
      result =
        input.settings.showArchivedChildren &&
        parent !== undefined &&
        input.expandedThreadIds.has(parent.id) &&
        isVisible(parent, seen);
    }
    decided.set(thread.id, result);
    return result;
  };

  const visible = scoped.filter((thread) => isVisible(thread, new Set()));
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
  // B9/B69: children stay on `latestAttentionAt`; only roots are sequenced.
  for (const siblings of childrenOf.values()) siblings.sort(byAttention);
  // B68.2 for every section at once. Grouping preserves this order, so no
  // section needs its own sort and the new B65 keys need no special case.
  roots.sort(byEntrance(input.sectionOrder));
  return { visible, byId, childrenOf, roots };
}

/**
 * Step 4 of §3. One write per root into a single map, so a thread satisfying two
 * predicates cannot land in two sections (B1, B67.5).
 */
function assignSections(
  roots: readonly PluginSidebarThread[],
  input: ListModelInput,
): Map<string, SectionKey> {
  const assignment = new Map<string, SectionKey>();
  // Built once, not per root: the predicate takes a set so that the hot path is
  // a membership test rather than a map lookup per band decision.
  const completedIds = new Set(input.completedAt.keys());
  for (const root of roots) {
    assignment.set(
      root.id,
      sectionKeyOf(root, input.settings, input.now, completedIds),
    );
  }
  return assignment;
}

/**
 * B86.3: the roots in the order the sections will read them.
 *
 * Every section takes its order from this one iteration (B68.2), so COMPLETED
 * gets its own rule by reordering the roots bound for it rather than by sorting
 * a section afterwards: newest mark first, because the thread most likely filed
 * by mistake is the one just filed. `id` breaks ties so the order is total.
 *
 * Roots outside COMPLETED keep their entrance order untouched.
 */
function orderRoots(
  roots: readonly PluginSidebarThread[],
  assignment: ReadonlyMap<string, SectionKey>,
  completedAt: ReadonlyMap<string, number>,
): readonly PluginSidebarThread[] {
  const filed = roots.filter((root) => assignment.get(root.id) === "completed");
  if (filed.length < 2) return roots;
  filed.sort((a, b) => {
    const delta = (completedAt.get(b.id) ?? 0) - (completedAt.get(a.id) ?? 0);
    if (delta !== 0) return delta;
    return a.id < b.id ? -1 : 1;
  });
  const rest = roots.filter((root) => assignment.get(root.id) !== "completed");
  return [...rest, ...filed];
}

/**
 * Labels for the sections whose name comes from data, keyed by the whole
 * section key so a project id and a host id can never collide.
 */
function dynamicLabelMap(input: ListModelInput): Map<SectionKey, string> {
  const labels = new Map<SectionKey, string>();
  for (const project of input.projects) {
    labels.set(`project:${project.id}`, project.name);
  }
  // B65.1: the machine's name, taken off the threads because the SDK gives the
  // sidebar no separate host list.
  for (const thread of input.threads) {
    if (thread.host) labels.set(`host:${thread.host.id}`, thread.host.name);
  }
  return labels;
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
  localHostId: string | null,
  completedAt: ReadonlyMap<string, number>,
  projectNameFallback: string | null = null,
): RenderRow {
  const filedAt = completedAt.get(thread.id);
  return {
    thread,
    isCompleted: filedAt !== undefined,
    // B86.2: `updatedAt` is a record write, not activity — which is exactly the
    // question here. Any write since the mark means the thread moved on, and
    // that is what the dot claims. `>` and not `>=`: the write that RECORDS the
    // completion lands at the same millisecond, and it is not news.
    hasUpdateSinceCompleted: filedAt !== undefined && thread.updatedAt > filedAt,
    title: resolveTitle(thread),
    workspaceLabel: resolveWorkspaceLabel(thread, localHostId),
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
  out.push(
    makeRow(
      root,
      tree,
      sectionKey,
      depth,
      projectNames,
      input.localHostId,
      input.completedAt,
    ),
  );
  // B10, inverted: a subtree is closed unless the user opened it.
  if (!input.expandedThreadIds.has(root.id)) return;
  for (const child of tree.childrenOf.get(root.id) ?? []) {
    flattenSubtree(child, tree, input, sectionKey, projectNames, out, depth + 1);
  }
}

function sectionOrderFor(
  input: ListModelInput,
  present: ReadonlySet<SectionKey>,
  dynamicLabels: ReadonlyMap<SectionKey, string>,
): SectionKey[] {
  // B67: DONE sits between NEEDS YOU and PINNED. In `status` mode neither band
  // is emitted (B65.5/B67.7), so these two keys are simply never present.
  const order: SectionKey[] = ["needs-you", "done", "pinned"];
  // B86.1: COMPLETED renders LAST, under every group the mode produces, even
  // though its band outranks them in `sectionKeyOf`. Precedence answers "which
  // section is this thread in"; this list answers "where does that section
  // sit". The whole point of the feature is that the pile is out of the way.
  if (input.settings.groupBy === "date") order.push(...DATE_BUCKET_ORDER);
  else if (input.settings.groupBy === "none") order.push("all");
  else if (input.settings.groupBy === "status") {
    for (const status of STATUS_GROUP_ORDER) order.push(`status:${status}`);
  } else if (input.settings.groupBy === "host") {
    // B65.2: machines by name, with `No machine` pinned last however it sorts.
    const hosts = [...present].filter(
      (key) => key !== NO_HOST_KEY && key.startsWith("host:"),
    );
    hosts.sort((a, b) =>
      labelFor(a, dynamicLabels).localeCompare(labelFor(b, dynamicLabels)),
    );
    order.push(...hosts, NO_HOST_KEY);
  } else {
    // B8: project sections follow the host's project order.
    for (const project of input.projects) order.push(`project:${project.id}`);
    // `completed` is appended below, after every mode's own groups; the
    // catch-all must not place it among the projects instead.
    for (const key of present) {
      if (key !== "completed" && !order.includes(key)) order.push(key);
    }
  }
  order.push("completed");
  return order;
}

function makeSection(
  key: SectionKey,
  rows: readonly RenderRow[],
  count: number,
  input: ListModelInput,
  dynamicLabels: ReadonlyMap<SectionKey, string>,
): RenderSection {
  const isCollapsible = isCollapsibleSection(key);
  // B86.4: the stored set lists the sections the user has TOGGLED, so for a
  // section that starts folded, membership means expanded. One stored list
  // still covers both defaults, and the user's first click settles either.
  const isCollapsed =
    isCollapsible &&
    (isCollapsedByDefault(key)
      ? !input.collapsedSections.has(key)
      : input.collapsedSections.has(key));
  return {
    key,
    label: labelFor(key, dynamicLabels),
    count,
    showCount: showsCount(key),
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
  dynamicLabels: ReadonlyMap<SectionKey, string>,
): RenderSection[] {
  const candidates: SearchCandidate[] = tree.visible.map((thread) => ({
    thread,
    title: resolveTitle(thread),
    projectName: projectNames.get(thread.projectId) ?? thread.projectId,
    // B69: search ranks by match, then entrance order.
    sequence: sequenceOf(thread, input.sectionOrder),
  }));
  const rows = rankSearch(candidates, input.searchQuery).map((candidate) =>
    makeRow(
      candidate.thread,
      tree,
      "search",
      0,
      projectNames,
      input.localHostId,
      // B86.5: search always reaches the filed threads, and the row says so.
      // Grouping is suspended here, so the section key cannot.
      input.completedAt,
      candidate.projectName,
    ),
  );
  if (rows.length === 0) return [];
  return [makeSection("search", rows, rows.length, input, dynamicLabels)];
}

function buildLiveSections(
  tree: Tree,
  input: ListModelInput,
  projectNames: ReadonlyMap<string, string>,
  dynamicLabels: ReadonlyMap<SectionKey, string>,
): RenderSection[] {
  const assignment = assignSections(tree.roots, input);
  const rowsBySection = new Map<SectionKey, RenderRow[]>();
  const countBySection = new Map<SectionKey, number>();
  for (const root of orderRoots(tree.roots, assignment, input.completedAt)) {
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
  const order = sectionOrderFor(input, new Set(rowsBySection.keys()), dynamicLabels);
  const sections: RenderSection[] = [];
  for (const key of order) {
    const count = countBySection.get(key) ?? 0;
    if (count === 0) continue; // B4: an empty section renders nothing at all
    sections.push(
      makeSection(key, rowsBySection.get(key) ?? [], count, input, dynamicLabels),
    );
  }
  return sections;
}

export function buildListModel(input: ListModelInput): ListModel {
  const tree = buildTree(input);
  const projectNames = projectNameMap(input);
  const dynamicLabels = dynamicLabelMap(input);
  const query = typeof input.searchQuery === "string" ? input.searchQuery : "";
  const sections =
    query.trim() === ""
      ? buildLiveSections(tree, input, projectNames, dynamicLabels)
      : buildSearchSections(tree, input, projectNames, dynamicLabels);
  let rowCount = 0;
  for (const section of sections) rowCount += section.rows.length;
  return { sections, rowCount };
}
