import { describe, expect, it } from "vitest";
import type {
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import {
  buildListModel,
  resolveTitle,
  resolveWorkspaceLabel,
  sectionKeyOf,
  usesHostLabel,
} from "./list-model";
import { dimLevelFor } from "./buckets";
// The REAL reconciler, not a copy of it (F6). Every entrance-order test below
// drives `useSectionOrder`'s own output into `buildListModel`, so the hook and
// the model can no longer diverge behind two agreeing stand-ins.
import { reconcileSectionOrder } from "../useSectionOrder";
import type {
  BetterSidebarSettings,
  ListModelInput,
  ListModel,
  SectionKey,
  SectionOrder,
} from "./types";

/** Fixed local epochs — never Date.now(). */
const NOW = new Date(2026, 7, 30, 12, 0, 0, 0).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

function thread(
  id: string,
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return {
    id,
    projectId: "p1",
    title: id,
    titleFallback: null,
    parentThreadId: null,
    sectionId: null,
    originKind: null,
    originPluginId: null,
    providerId: "acp-claude",
    hasPendingInteraction: false,
    activity: {
      workflows: 0,
      backgroundAgents: 0,
      backgroundCommands: 0,
      planMode: 0,
      goals: 0,
    },
    indicator: "none",
    indicatorLabel: null,
    isUnread: false,
    isPinned: false,
    isArchived: false,
    environment: null,
    host: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastReadAt: null,
    latestAttentionAt: NOW,
    ...overrides,
  };
}

const PROJECTS: PluginSidebarProject[] = [
  { id: "p1", name: "Acme", isPersonal: false },
  { id: "p2", name: "Beta", isPersonal: false },
];

function input(
  threads: readonly PluginSidebarThread[],
  overrides: Partial<ListModelInput> = {},
): ListModelInput {
  return {
    threads,
    projects: PROJECTS,
    settings: DEFAULT_SETTINGS,
    searchQuery: "",
    now: NOW,
    completedAt: new Map(),
    projectFilter: null,
    localHostId: null,
    sectionOrder: null,
    lastActivity: new Map<string, number>(),
    collapsedSections: new Set<SectionKey>(),
    // Every parent opened. The model's own default is CLOSED, but most cases
    // below are about ordering and sectioning and want the full tree; the
    // closed default has its own tests.
    expandedThreadIds: new Set(threads.map((entry) => entry.id)),
    ...overrides,
  };
}

const DEFAULT_SETTINGS: BetterSidebarSettings = {
  groupBy: "date",
  density: "default",
  showPrChip: true,
  showRelativeTime: true,
  showArchivedChildren: true,
  showHeaderChip: true,
  showSecondRow: true,
  showProjectName: true,
  showBranch: true,
  showModel: true,
  showQuickPin: true,
  showQuickMarkRead: false,
  showQuickArchive: true,
  showQuickCompleted: true,
  showEffort: false,
  showSubgroups: true,
};

/**
 * Mounts the entrance order over a thread set, exactly as `useSectionOrder`
 * does: the model's own `sectionKeyOf`, over the UNFILTERED set (B68.5).
 */
function mount(
  threads: readonly PluginSidebarThread[],
  settings: BetterSidebarSettings = DEFAULT_SETTINGS,
  current: SectionOrder | null = null,
): SectionOrder {
  return reconcileSectionOrder(current, threads, (thread) =>
    sectionKeyOf(thread, settings, NOW),
  );
}

/** The whole rendered sequence, flattened across sections — what B6 pins. */
function sequence(model: ListModel): string[] {
  return model.sections.flatMap((section) =>
    section.rows.map((row) => row.thread.id),
  );
}

function keys(model: ListModel): SectionKey[] {
  return model.sections.map((section) => section.key);
}

describe("precedence and emptiness (B1, B4)", () => {
  it("renders a pending+pinned thread once, in needs-you", () => {
    const model = buildListModel(
      input([thread("a", { hasPendingInteraction: true, isPinned: true })]),
    );
    expect(keys(model)).toEqual(["needs-you"]);
    expect(sequence(model)).toEqual(["a"]);
  });

  it("emits no id twice across a mixed list", () => {
    const model = buildListModel(
      input([
        thread("a", { hasPendingInteraction: true, isPinned: true }),
        thread("b", { isPinned: true }),
        thread("c"),
        thread("d", { latestAttentionAt: NOW - 10 * DAY_MS }),
      ]),
    );
    const ids = sequence(model);
    expect(new Set(ids).size).toBe(ids.length);
    expect(keys(model)).toEqual([
      "needs-you",
      "pinned",
      "today",
      "working:today",
      "last-30",
      "working:last-30",
    ]);
  });

  it("produces no RenderSection for a bucket with no threads", () => {
    const model = buildListModel(input([thread("a")]));
    expect(keys(model)).toEqual(["today", "working:today"]);
    expect(model.rowCount).toBe(1);
  });

  it("returns no sections at all for an empty thread list", () => {
    expect(buildListModel(input([])).sections).toEqual([]);
  });
});

describe("sort (B5)", () => {
  it("sorts each section by latestAttentionAt descending, tie-broken on id", () => {
    const model = buildListModel(
      input([
        thread("b", { latestAttentionAt: NOW - 1 }),
        thread("a", { latestAttentionAt: NOW - 1 }),
        thread("c", { latestAttentionAt: NOW }),
      ]),
    );
    expect(sequence(model)).toEqual(["c", "a", "b"]);
  });
});

describe("grouping modes (B8)", () => {
  const threads = [
    thread("needs", { hasPendingInteraction: true }),
    thread("pin", { isPinned: true }),
    thread("plain", { projectId: "p2" }),
  ];

  it("keeps needs-you and pinned first in every mode", () => {
    for (const groupBy of ["date", "project", "none"] as const) {
      const model = buildListModel(
        input(threads, {
          settings: { ...DEFAULT_SETTINGS, groupBy },
        }),
      );
      expect(keys(model).slice(0, 2)).toEqual(["needs-you", "pinned"]);
      expect(sequence(model)).toEqual(["needs", "pin", "plain"]);
    }
  });

  it("replaces date buckets with one section per project", () => {
    const model = buildListModel(
      input(threads, {
        settings: { ...DEFAULT_SETTINGS, groupBy: "project" },
      }),
    );
    expect(keys(model)).toEqual([
      "needs-you",
      "pinned",
      "project:p2",
      "working:project:p2",
    ]);
    expect(model.sections[2]!.label).toBe("BETA");
  });

  it("collapses everything else into one flat section for groupBy none", () => {
    const model = buildListModel(
      input(threads, {
        settings: { ...DEFAULT_SETTINGS, groupBy: "none" },
      }),
    );
    expect(keys(model)).toEqual(["needs-you", "pinned", "all", "working:all"]);
  });
});

describe("nesting (B9) and archived children (B11)", () => {
  it("renders a child of a pinned parent inside pinned at depth 1", () => {
    const model = buildListModel(
      input([
        thread("parent", { isPinned: true, latestAttentionAt: NOW - 20 * DAY_MS }),
        thread("child", { parentThreadId: "parent" }),
      ]),
    );
    expect(keys(model)).toEqual(["pinned"]);
    expect(sequence(model)).toEqual(["parent", "child"]);
    expect(model.sections[0]!.rows[1]!.depth).toBe(1);
    expect(model.sections[0]!.rows[0]!.childCount).toBe(1);
    // B53.4: two rows, one root — the section counts the root only.
    expect(model.sections[0]!.count).toBe(1);
  });

  /**
   * The motivating complaint: "the group counter is jumping". Subagents spawn
   * and finish under a parent continuously, and while the section counted them
   * the header churned although the user had started nothing new.
   */
  it("counts a section's root rows only, however many subagents spawn (B53.4)", () => {
    const roots = [thread("a"), thread("b")];
    const withSubagents = [
      ...roots,
      ...Array.from({ length: 16 }, (_, index) =>
        thread(`sub${index}`, { parentThreadId: "a" }),
      ),
    ];

    expect(buildListModel(input(roots)).sections.find((s) => s.key === "working:today")!.count).toBe(2);
    const busy = buildListModel(input(withSubagents));
    const working = busy.sections.find((s) => s.key === "working:today")!;
    expect(working.count).toBe(2);
    expect(working.rows).toHaveLength(18);
    // The volume is reported where it belongs: on the parent (B53.2).
    expect(working.rows[0]!.childCount).toBe(16);
  });

  /**
   * B10, inverted. The rule the app runs on: a parent with children is closed
   * unless its id is in the expanded set. Every other case in this file opts
   * INTO the open tree through `input()`, so this is the one that pins the
   * default itself.
   */
  it("collapses every parent by default, whatever the depth", () => {
    const threads = [
      thread("parent"),
      thread("child", { parentThreadId: "parent" }),
      thread("grandchild", { parentThreadId: "child" }),
      thread("other"),
    ];
    const model = buildListModel(
      input(threads, { expandedThreadIds: new Set<string>() }),
    );

    expect(sequence(model)).toEqual(["other", "parent"]);
  });

  it("opens one level at a time, never the whole subtree at once", () => {
    const threads = [
      thread("parent"),
      thread("child", { parentThreadId: "parent" }),
      thread("grandchild", { parentThreadId: "child" }),
    ];

    // Opening the parent reveals its child, whose own subtree stays closed.
    expect(
      sequence(
        buildListModel(input(threads, { expandedThreadIds: new Set(["parent"]) })),
      ),
    ).toEqual(["parent", "child"]);

    expect(
      sequence(
        buildListModel(
          input(threads, { expandedThreadIds: new Set(["parent", "child"]) }),
        ),
      ),
    ).toEqual(["parent", "child", "grandchild"]);
  });

  /** An id in the set whose parent is closed reveals nothing on its own. */
  it("keeps a grandchild hidden while its parent's parent is closed", () => {
    const threads = [
      thread("parent"),
      thread("child", { parentThreadId: "parent" }),
      thread("grandchild", { parentThreadId: "child" }),
    ];

    expect(
      sequence(
        buildListModel(input(threads, { expandedThreadIds: new Set(["child"]) })),
      ),
    ).toEqual(["parent"]);
  });

  it("keeps a section's count invariant across collapsing a subtree in it (B53.5)", () => {
    const threads = [
      thread("parent"),
      thread("child", { parentThreadId: "parent" }),
      thread("grandchild", { parentThreadId: "child" }),
      thread("other"),
    ];
    const expanded = buildListModel(input(threads));
    const collapsed = buildListModel(
      input(threads, { expandedThreadIds: new Set<string>() }),
    );

    const rowsOf = (model: ListModel) =>
      model.sections.find((s) => s.key === "working:today")!.rows;
    expect(rowsOf(expanded)).toHaveLength(4);
    expect(rowsOf(collapsed)).toHaveLength(2);
    expect(collapsed.sections.find((s) => s.key === "working:today")!.count).toBe(
      expanded.sections.find((s) => s.key === "working:today")!.count,
    );
    expect(expanded.sections.find((s) => s.key === "working:today")!.count).toBe(2);
  });

  it("hides an archived root but shows an archived child of an expanded parent", () => {
    const threads = [
      thread("parent"),
      thread("child", { parentThreadId: "parent", isArchived: true }),
      thread("loose", { isArchived: true }),
    ];
    expect(sequence(buildListModel(input(threads)))).toEqual(["parent", "child"]);
    expect(
      sequence(
        buildListModel(
          input(threads, { expandedThreadIds: new Set<string>() }),
        ),
      ),
    ).toEqual(["parent"]);
  });

  it("drops the archived child when showArchivedChildren is off (B59)", () => {
    const threads = [
      thread("parent"),
      thread("child", { parentThreadId: "parent", isArchived: true }),
    ];
    const model = buildListModel(
      input(threads, {
        settings: { ...DEFAULT_SETTINGS, showArchivedChildren: false },
      }),
    );
    expect(sequence(model)).toEqual(["parent"]);
    expect(
      model.sections.find((s) => s.key === "working:today")!.rows[0]!.childCount,
    ).toBe(0);
  });

  it("treats a thread whose parent is absent as its own root", () => {
    const model = buildListModel(input([thread("orphan", { parentThreadId: "gone" })]));
    expect(sequence(model)).toEqual(["orphan"]);
    expect(
      model.sections.find((s) => s.key === "working:today")!.rows[0]!.depth,
    ).toBe(0);
  });

  it("keeps the count of a collapsed section while emitting no rows", () => {
    const model = buildListModel(
      input([thread("a"), thread("b")], {
        collapsedSections: new Set<SectionKey>(["working:today"]),
      }),
    );
    const folded = model.sections.find((s) => s.key === "working:today")!;
    expect(folded.count).toBe(2);
    expect(folded.isCollapsed).toBe(true);
    expect(model.rowCount).toBe(0);
  });
});

describe("title resolution (B13)", () => {
  it("walks title, then titleFallback, then Untitled", () => {
    expect(resolveTitle(thread("a", { title: " Real " }))).toBe("Real");
    expect(resolveTitle(thread("a", { title: null, titleFallback: " Fb " }))).toBe("Fb");
    expect(resolveTitle(thread("a", { title: null, titleFallback: "  " }))).toBe(
      "Untitled",
    );
    expect(resolveTitle(thread("a", { title: null, titleFallback: null }))).toBe(
      "Untitled",
    );
  });

  it("does not fall through to the fallback for a whitespace-only title (F5)", () => {
    // The chain is nullish: a thread the host considers named never borrows
    // another field's text just because its own title trims to nothing.
    expect(
      resolveTitle(thread("a", { title: "   ", titleFallback: " Fallback " })),
    ).toBe("Untitled");
  });

  it("puts the resolved title on the row, not the raw field", () => {
    const model = buildListModel(
      input([thread("a", { title: null, titleFallback: " Fallback " })]),
    );
    expect(
      model.sections.find((s) => s.key === "working:today")!.rows[0]!.title,
    ).toBe("Fallback");
  });
});

describe("workspace label (B16 under the §7 ruling)", () => {
  it("prefers the branch name", () => {
    expect(
      resolveWorkspaceLabel(
        thread("a", {
          environment: {
            id: "e",
            name: "wt",
            branchName: " feat/x ",
            workspaceDisplayKind: "managed-worktree",
          },
          host: { id: "h", name: "mac" },
        }),
        null,
      ),
    ).toBe("feat/x");
  });

  it("falls back to environment.name only for worktree workspaces", () => {
    const env = { id: "e", name: "wt", branchName: null } as const;
    expect(
      resolveWorkspaceLabel(
        thread("a", {
          environment: { ...env, workspaceDisplayKind: "unmanaged-worktree" },
        }),
        null,
      ),
    ).toBe("wt");
    expect(
      resolveWorkspaceLabel(
        thread("a", {
          environment: { ...env, workspaceDisplayKind: "other" },
          host: { id: "h", name: "mac" },
        }),
        null,
      ),
    ).toBe("mac");
  });

  it("yields null for a null environment without throwing", () => {
    expect(resolveWorkspaceLabel(thread("a", { environment: null }), null)).toBeNull();
    expect(
      resolveWorkspaceLabel(
        thread("a", {
          environment: null,
          host: { id: "h", name: "mac" },
        }),
        null,
      ),
    ).toBeNull();
  });

  it("drops the machine name when the thread runs on this machine", () => {
    const local = thread("a", {
      environment: {
        id: "e",
        name: null,
        branchName: null,
        workspaceDisplayKind: "other",
      },
      host: { id: "host_1", name: "maxbook" },
    });

    expect(resolveWorkspaceLabel(local, "host_1")).toBeNull();
    // A different machine is exactly the case the name is worth drawing for.
    expect(resolveWorkspaceLabel(local, "host_2")).toBe("maxbook");
    // Unknown local host: nothing is hidden.
    expect(resolveWorkspaceLabel(local, null)).toBe("maxbook");
  });

  it("keeps a branch even on this machine, because a branch is not the machine", () => {
    const local = thread("a", {
      environment: {
        id: "e",
        name: null,
        branchName: "feat/x",
        workspaceDisplayKind: "other",
      },
      host: { id: "host_1", name: "maxbook" },
    });

    expect(resolveWorkspaceLabel(local, "host_1")).toBe("feat/x");
  });

  it("asks for the local host only for a thread whose label would use it", () => {
    const withBranch = thread("a", {
      environment: {
        id: "e",
        name: null,
        branchName: "feat/x",
        workspaceDisplayKind: "other",
      },
      host: { id: "host_1", name: "maxbook" },
    });
    const withoutHost = thread("b", {
      environment: {
        id: "e",
        name: null,
        branchName: null,
        workspaceDisplayKind: "other",
      },
      host: null,
    });
    const needsIt = thread("c", {
      environment: {
        id: "e",
        name: null,
        branchName: null,
        workspaceDisplayKind: "other",
      },
      host: { id: "host_1", name: "maxbook" },
    });

    // B16 skips the WHOLE chain without an environment, machine included, so
    // a thread with none cannot spend the request either.
    const noEnvironment = thread("d", {
      environment: null,
      host: { id: "host_1", name: "maxbook" },
    });

    expect(usesHostLabel(withBranch)).toBe(false);
    expect(usesHostLabel(withoutHost)).toBe(false);
    expect(usesHostLabel(noEnvironment)).toBe(false);
    expect(usesHostLabel(needsIt)).toBe(true);
    expect(resolveWorkspaceLabel(noEnvironment, null)).toBeNull();
  });

  it("yields null when the whole chain is empty", () => {
    expect(
      resolveWorkspaceLabel(
        thread("a", {
          environment: {
            id: "e",
            name: null,
            branchName: null,
            workspaceDisplayKind: "other",
          },
          host: null,
        }),
        null,
      ),
    ).toBeNull();
  });
});

describe("dim levels (B41)", () => {
  it("assigns 0 to needs-you, pinned and today, and steps down for older buckets", () => {
    const model = buildListModel(
      input([
        thread("n", { hasPendingInteraction: true }),
        thread("t"),
        thread("y", { latestAttentionAt: NOW - DAY_MS }),
        thread("o", { latestAttentionAt: NOW - 90 * DAY_MS }),
      ]),
    );
    const byId = new Map(
      model.sections.flatMap((s) => s.rows.map((r) => [r.thread.id, r.dimLevel])),
    );
    expect(byId.get("n")).toBe(0);
    expect(byId.get("t")).toBe(0);
    expect(byId.get("y")).toBe(1);
    expect(byId.get("o")).toBe(3);
  });
});

describe("search (B43)", () => {
  const threads = [
    thread("alpha", { title: "deploy the thing", hasPendingInteraction: true }),
    thread("beta", { title: "fix the deploy", projectId: "p2" }),
    thread("gamma", { title: "child of alpha", parentThreadId: "alpha" }),
    thread("delta", { title: "unrelated", isPinned: true }),
  ];

  it("suspends grouping into exactly one flat section", () => {
    const model = buildListModel(input(threads, { searchQuery: "deploy" }));
    expect(keys(model)).toEqual(["search"]);
    expect(model.sections[0]!.rows.every((row) => row.depth === 0)).toBe(true);
    expect(model.sections[0]!.rows.every((row) => row.dimLevel === 0)).toBe(true);
    expect(sequence(model)).toEqual(["alpha", "beta"]);
  });

  it("populates projectName on every result row", () => {
    const model = buildListModel(input(threads, { searchQuery: "e" }));
    expect(model.sections[0]!.rows.every((row) => row.projectName !== null)).toBe(true);
  });

  it("restores buckets when the query clears", () => {
    expect(keys(buildListModel(input(threads, { searchQuery: "   " })))).toEqual([
      "needs-you",
      "pinned",
      "today",
      "working:today",
    ]);
  });

  it("returns no sections when nothing matches", () => {
    expect(buildListModel(input(threads, { searchQuery: "zzz" })).sections).toEqual([]);
  });
});

describe("entrance order (B68, B69)", () => {
  const base = [
    thread("a", { latestAttentionAt: NOW - 1000 }),
    thread("b", { latestAttentionAt: NOW - 2000 }),
    thread("c", { isPinned: true, latestAttentionAt: NOW - 3000 }),
  ];

  it("seeds the first mount in the B5 order it replaces (B68.3)", () => {
    const sectionOrder = mount(base);
    expect(sequence(buildListModel(input(base, { sectionOrder })))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("breaks a first-mount tie by createdAt, then id, so the seed is total (B68.3)", () => {
    const tied = [
      thread("b2", { latestAttentionAt: NOW, createdAt: NOW - 5 }),
      thread("b1", { latestAttentionAt: NOW, createdAt: NOW - 5 }),
      thread("older", { latestAttentionAt: NOW, createdAt: NOW - 50 }),
    ];
    const sectionOrder = mount(tied);
    expect(sequence(buildListModel(input(tied, { sectionOrder })))).toEqual([
      "b1",
      "b2",
      "older",
    ]);
  });

  it("keeps a thread's index when its attention overtakes the row above it (B68.1)", () => {
    const sectionOrder = mount(base);
    const bumped = base.map((t) =>
      t.id === "b" ? thread("b", { latestAttentionAt: NOW }) : t,
    );
    // The same section, so no new entrance: the order is unmoved.
    const after = mount(bumped, DEFAULT_SETTINGS, sectionOrder);
    expect(sequence(buildListModel(input(bumped, { sectionOrder: after })))).toEqual([
      "c",
      "a",
      "b",
    ]);
    // Without the order map the model falls back to attention, which is the
    // very movement B68 exists to stop.
    expect(sequence(buildListModel(input(bumped)))).toEqual(["c", "b", "a"]);
  });

  it("lands a new entrant at the TOP of its section, moving nothing below it (B68.2)", () => {
    const sectionOrder = mount(base);
    const arrived = [...base, thread("new", { latestAttentionAt: NOW - 9999 })];
    const after = mount(arrived, DEFAULT_SETTINGS, sectionOrder);
    // `new` has the OLDEST attention and still renders first in `today`: its
    // position comes from when it entered, not from its timestamp.
    expect(sequence(buildListModel(input(arrived, { sectionOrder: after })))).toEqual([
      "c",
      "new",
      "a",
      "b",
    ]);
  });

  it("gives a thread that changes section a new entrance at the top of it (B68.1)", () => {
    const sectionOrder = mount(base);
    const promoted = base.map((t) =>
      t.id === "b" ? thread("b", { hasPendingInteraction: true }) : t,
    );
    const after = mount(promoted, DEFAULT_SETTINGS, sectionOrder);
    const model = buildListModel(input(promoted, { sectionOrder: after }));
    expect(keys(model)).toEqual(["needs-you", "pinned", "today", "working:today"]);
    expect(sequence(model)).toEqual(["b", "c", "a"]);
  });

  it("drops a departed thread's entry, so returning is a new entrance (B68.6)", () => {
    const seeded = mount(base);
    const withoutA = base.filter((t) => t.id !== "a");
    const afterExit = mount(withoutA, DEFAULT_SETTINGS, seeded);
    expect(afterExit.entries.has("a")).toBe(false);
    const afterReturn = mount(base, DEFAULT_SETTINGS, afterExit);
    // `a` re-enters `today` and therefore renders above `b`, which never left.
    expect(sequence(buildListModel(input(base, { sectionOrder: afterReturn })))).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(afterReturn.entries.get("a")!.sequence).toBeGreaterThan(
      afterReturn.entries.get("b")!.sequence,
    );
  });

  it("leaves the order unchanged when a project filter is applied and then cleared (B68.5)", () => {
    const mixed = [
      thread("a1", { projectId: "p1", latestAttentionAt: NOW - 1000 }),
      thread("b1", { projectId: "p2", latestAttentionAt: NOW - 2000 }),
      thread("a2", { projectId: "p1", latestAttentionAt: NOW - 3000 }),
    ];
    const seeded = mount(mixed);
    const before = sequence(buildListModel(input(mixed, { sectionOrder: seeded })));
    expect(before).toEqual(["a1", "b1", "a2"]);

    // Scoped: the reconciler still sees the UNFILTERED set, so nothing that the
    // scope hides is treated as having left its section.
    const scoped = mount(mixed, DEFAULT_SETTINGS, seeded);
    expect(
      sequence(buildListModel(input(mixed, { sectionOrder: scoped, projectFilter: "p1" }))),
    ).toEqual(["a1", "a2"]);

    const cleared = mount(mixed, DEFAULT_SETTINGS, scoped);
    expect(sequence(buildListModel(input(mixed, { sectionOrder: cleared })))).toEqual(
      before,
    );
  });

  it("does not re-sequence a thread that a search is hiding (B68.5)", () => {
    const seeded = mount(base);
    const searching = mount(base, DEFAULT_SETTINGS, seeded);
    expect(searching.entries).toEqual(seeded.entries);
    expect(searching.nextSequence).toBe(seeded.nextSequence);
  });

  it("drops a section that emptied rather than rendering a bare header", () => {
    const sectionOrder = mount(base);
    const model = buildListModel(
      input(base.filter((t) => t.id !== "c"), { sectionOrder }),
    );
    expect(keys(model)).toEqual(["today", "working:today"]);
    expect(sequence(model)).toEqual(["a", "b"]);
  });

  it("ranks a search by match, then entrance order (B69)", () => {
    const threads = [
      thread("m1", { title: "deploy one", latestAttentionAt: NOW - 1000 }),
      thread("m2", { title: "deploy two", latestAttentionAt: NOW - 2000 }),
    ];
    const seeded = mount(threads);
    // `m2` re-enters its section and so outranks `m1`, whose attention is newer.
    const moved = threads.map((t) =>
      t.id === "m2" ? thread("m2", { title: "deploy two", isPinned: true }) : t,
    );
    const after = mount(moved, DEFAULT_SETTINGS, seeded);
    expect(
      sequence(
        buildListModel(input(moved, { sectionOrder: after, searchQuery: "deploy" })),
      ),
    ).toEqual(["m2", "m1"]);
  });

  // --- Structure is the live model's; the sequence map orders, nothing more ---

  it("keeps children directly beneath their parent when a subtree is expanded (B9, B69)", () => {
    const threads = [
      thread("p", { latestAttentionAt: NOW - 1000 }),
      thread("kid1", { parentThreadId: "p", latestAttentionAt: NOW - 1100 }),
      thread("kid2", { parentThreadId: "p", latestAttentionAt: NOW - 1200 }),
      thread("tail", { latestAttentionAt: NOW - 5000 }),
    ];
    // Mounted while `p` is collapsed: the children were never rendered.
    const collapsed = { expandedThreadIds: new Set<string>() };
    const seeded = mount(threads);
    expect(sequence(buildListModel(input(threads, { ...collapsed, sectionOrder: seeded })))).toEqual([
      "p",
      "tail",
    ]);

    const model = buildListModel(input(threads, { sectionOrder: seeded }));

    expect(sequence(model)).toEqual(["p", "kid1", "kid2", "tail"]);
    expect(
      model.sections.find((s) => s.key === "working:today")!.rows.map((row) => row.depth),
    ).toEqual([0, 1, 1, 0]);
    // The children are not entrants of their own: they move with the subtree.
    expect(sequence(model).indexOf("kid1")).toBeLessThan(
      sequence(model).indexOf("tail"),
    );
  });

  it("keeps a collapsed section present with its header and count (B53.5)", () => {
    const threads = [
      thread("t1"),
      thread("t2"),
      thread("old", { latestAttentionAt: NOW - 10 * DAY_MS }),
    ];
    const sectionOrder = mount(threads);
    const model = buildListModel(
      input(threads, {
        sectionOrder,
        collapsedSections: new Set<SectionKey>(["working:today"]),
      }),
    );

    // The section that owns the rows is the WORKING subgroup now; folding it
    // keeps its header and its root count while emitting no rows.
    const working = model.sections.find((section) => section.key === "working:today");
    expect(working).toBeDefined();
    expect(working!.isCollapsed).toBe(true);
    expect(working!.label).toBe("WORKING");
    expect(working!.count).toBe(2);
    expect(working!.rows).toEqual([]);
    expect(sequence(model)).toEqual(["old"]);
    expect(keys(model)).toEqual([
      "today",
      "working:today",
      "last-30",
      "working:last-30",
    ]);
  });

  it("takes section membership from the live model, never from the sequence map", () => {
    // `late` ages out of `today` into `last-30`. The sequence map still holds
    // its OLD section, and the live model's answer must win — inverting this
    // is what shipped a blocker in the overlay this replaces.
    const threads = [thread("a"), thread("late")];
    const stale = mount(threads);
    expect(stale.entries.get("late")!.section).toBe("working:today");
    const aged = [thread("a"), thread("late", { latestAttentionAt: NOW - 10 * DAY_MS })];
    const model = buildListModel(input(aged, { sectionOrder: stale }));
    expect(keys(model)).toEqual([
      "today",
      "working:today",
      "last-30",
      "working:last-30",
    ]);
    expect(
      model.sections.find((s) => s.key === "working:last-30")!.rows.map((r) => r.thread.id),
    ).toEqual(["late"]);
    for (const section of model.sections) {
      const expected =
        section.key === "today"
          ? "TODAY"
          : section.key === "last-30"
            ? "LAST 30 DAYS"
            : "WORKING";
      expect(section.label).toBe(expected);
    }
  });
});

describe("DONE band (B67)", () => {
  it("puts an unread-success root in DONE, between NEEDS YOU and PINNED", () => {
    const threads = [
      thread("pending", { hasPendingInteraction: true }),
      thread("finished", { indicator: "unread-success", isUnread: true }),
      thread("failed", { indicator: "unread-error", isUnread: true }),
      thread("pin", { isPinned: true }),
      thread("plain"),
    ];
    const model = buildListModel(input(threads, { sectionOrder: mount(threads) }));
    expect(keys(model)).toEqual([
      "needs-you",
      "done",
      "pinned",
      "today",
      "working:today",
    ]);
    const done = model.sections.find((section) => section.key === "done")!;
    expect(done.rows.map((row) => row.thread.id).sort()).toEqual(["failed", "finished"]);
    expect(done.label).toBe("DONE");
    expect(done.isCollapsible).toBe(true);
  });

  it("leaves a thread that is unread but still running out of DONE (B67.1)", () => {
    const threads = [thread("running", { indicator: "runtime", isUnread: true })];
    expect(keys(buildListModel(input(threads)))).toEqual([
      "today",
      "working:today",
    ]);
  });

  it("never promotes a parent for a completed CHILD (B67.3)", () => {
    const threads = [
      thread("parent"),
      thread("child", { parentThreadId: "parent", indicator: "unread-success" }),
    ];
    const model = buildListModel(input(threads, { sectionOrder: mount(threads) }));
    // One section, and the child is still nested where it already was.
    expect(keys(model)).toEqual(["today", "working:today"]);
    expect(
      model.sections.find((s) => s.key === "working:today")!.rows.map((row) => row.depth),
    ).toEqual([0, 1]);
  });

  it("shows a pending AND unread thread only in NEEDS YOU (B67.5)", () => {
    const threads = [
      thread("both", { hasPendingInteraction: true, indicator: "unread-success" }),
    ];
    const model = buildListModel(input(threads, { sectionOrder: mount(threads) }));
    expect(keys(model)).toEqual(["needs-you"]);
    expect(sequence(model)).toEqual(["both"]);
  });

  it("counts roots only, and renders nothing when empty (B67.6, B67.8)", () => {
    const threads = [
      thread("finished", { indicator: "unread-success" }),
      thread("kid", { parentThreadId: "finished", indicator: "unread-success" }),
    ];
    const model = buildListModel(input(threads, { sectionOrder: mount(threads) }));
    expect(model.sections.find((section) => section.key === "done")!.count).toBe(1);
    expect(keys(buildListModel(input([thread("plain")])))).not.toContain("done");
  });
});

describe("host and status grouping (B65)", () => {
  const HOST_SETTINGS: BetterSidebarSettings = { ...DEFAULT_SETTINGS, groupBy: "host" };
  const STATUS_SETTINGS: BetterSidebarSettings = {
    ...DEFAULT_SETTINGS,
    groupBy: "status",
  };

  it("groups by host name and puts a null host under No machine, last (B65.1, B65.2)", () => {
    const threads = [
      thread("z", { host: { id: "h2", name: "zeta" } }),
      thread("none1"),
      thread("a", { host: { id: "h1", name: "alpha" } }),
    ];
    const model = buildListModel(
      input(threads, { settings: HOST_SETTINGS, sectionOrder: mount(threads, HOST_SETTINGS) }),
    );
    expect(keys(model)).toEqual([
      "host:h1",
      "working:host:h1",
      "host:h2",
      "working:host:h2",
      "host:none",
      "working:host:none",
    ]);
    expect(model.sections.map((section) => section.label)).toEqual([
      "ALPHA",
      "WORKING",
      "ZETA",
      "WORKING",
      "NO MACHINE",
      "WORKING",
    ]);
    expect(sequence(model)).toEqual(["a", "z", "none1"]);
  });

  it("merges the NEEDS YOU band into the first status group (B65.5)", () => {
    const threads = [
      thread("pending", { hasPendingInteraction: true }),
      thread("busy", { indicator: "runtime" }),
    ];
    const model = buildListModel(
      input(threads, {
        settings: STATUS_SETTINGS,
        sectionOrder: mount(threads, STATUS_SETTINGS),
      }),
    );
    // One heading for the concept, never a band AND a group (B65.5).
    expect(keys(model)).toEqual(["status:needs-you", "status:working"]);
    expect(keys(model)).not.toContain("needs-you");
  });

  it("merges the DONE band into the Unread status group (B67.7)", () => {
    const threads = [
      thread("finished", { indicator: "unread-success" }),
      thread("idle1"),
    ];
    const model = buildListModel(
      input(threads, {
        settings: STATUS_SETTINGS,
        sectionOrder: mount(threads, STATUS_SETTINGS),
      }),
    );
    expect(keys(model)).toEqual(["status:unread", "status:idle"]);
    expect(keys(model)).not.toContain("done");
  });

  it("still floats PINNED above every status group (B65.6)", () => {
    const threads = [thread("pin", { isPinned: true }), thread("busy", { indicator: "runtime" })];
    const model = buildListModel(
      input(threads, {
        settings: STATUS_SETTINGS,
        sectionOrder: mount(threads, STATUS_SETTINGS),
      }),
    );
    expect(keys(model)).toEqual(["pinned", "status:working"]);
  });

  it("renders empty status groups not at all (B65.7)", () => {
    const threads = [thread("only", { indicator: "draft" })];
    expect(
      keys(buildListModel(input(threads, { settings: STATUS_SETTINGS }))),
    ).toEqual(["status:draft"]);
  });

  it("counts roots only in the new modes too, exactly as the date buckets do (B65.9)", () => {
    const threads = [
      thread("root", { host: { id: "h1", name: "alpha" } }),
      thread("kid", { parentThreadId: "root", host: { id: "h1", name: "alpha" } }),
    ];
    const model = buildListModel(
      input(threads, { settings: HOST_SETTINGS, sectionOrder: mount(threads, HOST_SETTINGS) }),
    );
    const working = model.sections.find((s) => s.key === "working:host:h1")!;
    expect(working.count).toBe(1);
    expect(working.rows).toHaveLength(2);
  });
});

describe("project scope filter (B64)", () => {
  const mixed = [
    thread("a1", { projectId: "p1", latestAttentionAt: NOW - 1000 }),
    thread("b1", { projectId: "p2", latestAttentionAt: NOW - 2000 }),
    thread("pin2", { projectId: "p2", isPinned: true }),
  ];

  it("removes out-of-scope threads from every section", () => {
    const model = buildListModel(
      input(mixed, { projectFilter: "p1", sectionOrder: mount(mixed) }),
    );
    expect(sequence(model)).toEqual(["a1"]);
    expect(keys(model)).toEqual(["today", "working:today"]);
  });

  it("does not change band precedence (B64.6)", () => {
    const model = buildListModel(
      input(mixed, { projectFilter: "p2", sectionOrder: mount(mixed) }),
    );
    expect(keys(model)).toEqual(["pinned", "today", "working:today"]);
    expect(sequence(model)).toEqual(["pin2", "b1"]);
  });

  it("composes with search (B64.3)", () => {
    const threads = [
      thread("hit", { projectId: "p1", title: "deploy here" }),
      thread("other", { projectId: "p2", title: "deploy there" }),
    ];
    const model = buildListModel(
      input(threads, { projectFilter: "p1", searchQuery: "deploy" }),
    );
    expect(keys(model)).toEqual(["search"]);
    expect(sequence(model)).toEqual(["hit"]);
  });

  it("renders no sections at all when the scope matches nothing (B64.4)", () => {
    expect(buildListModel(input(mixed, { projectFilter: "p3" })).sections).toEqual([]);
  });
});

describe("parent cycles (B1, F4)", () => {
  it("renders both members of an A→B→A cycle exactly once, as roots", () => {
    const model = buildListModel(
      input([
        thread("a", { parentThreadId: "b", latestAttentionAt: NOW }),
        thread("b", { parentThreadId: "a", latestAttentionAt: NOW - 1 }),
      ]),
    );
    const ids = sequence(model);
    expect(ids).toEqual(["a", "b"]);
    expect(new Set(ids).size).toBe(2);
    expect(
      model.sections.find((s) => s.key === "working:today")!.rows.every((row) => row.depth === 0),
    ).toBe(true);
    expect(model.sections.find((s) => s.key === "working:today")!.count).toBe(2);
  });

  it("keeps a non-cyclic child of a cycle member nested under it", () => {
    const model = buildListModel(
      input([
        thread("a", { parentThreadId: "b", latestAttentionAt: NOW }),
        thread("b", { parentThreadId: "a", latestAttentionAt: NOW - 2 }),
        thread("kid", { parentThreadId: "a", latestAttentionAt: NOW - 1 }),
      ]),
    );
    expect(sequence(model)).toEqual(["a", "kid", "b"]);
    expect(model.sections.find((s) => s.key === "working:today")!.rows[1]!.depth).toBe(1);
  });
});

/**
 * B86. Two things make these read oddly, and both are deliberate:
 *
 * - A COMPLETED subgroup is folded by DEFAULT, and the stored set lists the
 *   sections the user TOGGLED, so naming a subgroup in `collapsedSections` is
 *   what EXPANDS it.
 * - Completion outranks the DONE band and the pin in `sectionKeyOf`, but a
 *   subgroup renders directly under its own group rather than at the foot of
 *   the list. Precedence and render order answer different questions.
 */
describe("COMPLETED subgroups (B86)", () => {
  const filed = (ids: Record<string, number>) => new Map(Object.entries(ids));
  const expand = (...keys: SectionKey[]) => new Set<SectionKey>(keys);

  it("puts a filed thread in its own group's subgroup, directly under it", () => {
    const threads = [thread("a"), thread("b")];
    const model = buildListModel(
      input(threads, {
        sectionOrder: mount(threads),
        completedAt: filed({ b: NOW - 1000 }),
      }),
    );
    expect(keys(model)).toEqual(["today", "working:today", "completed:today"]);
    expect(sequence(model)).toEqual(["a"]); // folded, so it draws no rows
  });

  it("hides a subgroup whose group is collapsed", () => {
    const threads = [thread("a"), thread("b")];
    const model = buildListModel(
      input(threads, {
        sectionOrder: mount(threads),
        completedAt: filed({ b: NOW - 1000 }),
        collapsedSections: expand("today"),
      }),
    );
    // The group header survives, folded; the subgroups are not rendered at
    // all — not folded under it, gone.
    expect(keys(model)).toEqual(["today"]);
    expect(model.sections[0]!.rows).toEqual([]);
    expect(model.sections[0]!.isCollapsed).toBe(true);
  });

  it("brings the subgroup back when the group is reopened", () => {
    const threads = [thread("a"), thread("b")];
    const model = buildListModel(
      input(threads, {
        sectionOrder: mount(threads),
        completedAt: filed({ b: NOW - 1000 }),
      }),
    );
    expect(keys(model)).toEqual(["today", "working:today", "completed:today"]);
  });

  it("gives every group its own subgroup rather than one shared pile", () => {
    const threads = [
      thread("a", { projectId: "p1" }),
      thread("b", { projectId: "p2" }),
      thread("filed-1", { projectId: "p1" }),
      thread("filed-2", { projectId: "p2" }),
    ];
    const model = buildListModel(
      input(threads, {
        settings: { ...DEFAULT_SETTINGS, groupBy: "project" },
        sectionOrder: mount(threads, { ...DEFAULT_SETTINGS, groupBy: "project" }),
        completedAt: filed({ "filed-1": NOW - 1, "filed-2": NOW - 2 }),
        collapsedSections: expand("completed:project:p1", "completed:project:p2"),
      }),
    );
    expect(keys(model)).toEqual([
      "project:p1",
      "working:project:p1",
      "completed:project:p1",
      "project:p2",
      "working:project:p2",
      "completed:project:p2",
    ]);
    expect(sequence(model)).toEqual(["a", "filed-1", "b", "filed-2"]);
  });

  it("keeps the group header when every one of its threads is filed", () => {
    // Without this, `project:p2` renders nothing and its subgroup appears
    // directly under `project:p1`'s rows — reading as p1's filed threads.
    const threads = [
      thread("a", { projectId: "p1" }),
      thread("all-filed", { projectId: "p2" }),
    ];
    const model = buildListModel(
      input(threads, {
        settings: { ...DEFAULT_SETTINGS, groupBy: "project" },
        completedAt: filed({ "all-filed": NOW - 1 }),
        collapsedSections: expand("completed:project:p2"),
      }),
    );
    expect(keys(model)).toEqual([
      "project:p1",
      "working:project:p1",
      "project:p2",
      "completed:project:p2",
    ]);
    // The header is there, and it is genuinely empty.
    const empty = model.sections.find((s) => s.key === "project:p2")!;
    expect(empty.rows).toEqual([]);
    expect(empty.count).toBe(0);
  });

  it("still renders nothing for a group with neither rows nor filed threads", () => {
    const model = buildListModel(
      input([thread("a", { projectId: "p1" })], {
        settings: { ...DEFAULT_SETTINGS, groupBy: "project" },
      }),
    );
    expect(keys(model)).toEqual(["project:p1", "working:project:p1"]);
  });

  it("labels every subgroup COMPLETED, never its group's own name", () => {
    const threads = [thread("filed", { projectId: "p1" })];
    const model = buildListModel(
      input(threads, {
        settings: { ...DEFAULT_SETTINGS, groupBy: "project" },
        completedAt: filed({ filed: NOW - 1 }),
      }),
    );
    const section = model.sections.find((entry) => entry.key === "completed:project:p1")!;
    expect(section.label).toBe("COMPLETED");
    expect(section.isSubgroup).toBe(true);
  });

  it("is folded on arrival and shows its count, alone among sections", () => {
    const threads = [thread("a"), thread("b")];
    const model = buildListModel(
      input(threads, {
        sectionOrder: mount(threads),
        completedAt: filed({ b: NOW - 1000 }),
      }),
    );
    const completed = model.sections.find((s) => s.key === "completed:today")!;
    expect(completed.isCollapsed).toBe(true);
    expect(completed.count).toBe(1);
    expect(completed.showCount).toBe(true);
    const today = model.sections.find((s) => s.key === "today")!;
    expect(today.showCount).toBe(false);
    expect(today.isSubgroup).toBe(false);
  });

  it("folds each subgroup on its own, so opening one leaves the rest shut", () => {
    const threads = [
      thread("filed-1", { projectId: "p1" }),
      thread("filed-2", { projectId: "p2" }),
    ];
    const model = buildListModel(
      input(threads, {
        settings: { ...DEFAULT_SETTINGS, groupBy: "project" },
        completedAt: filed({ "filed-1": NOW - 1, "filed-2": NOW - 2 }),
        collapsedSections: expand("completed:project:p1"),
      }),
    );
    expect(sequence(model)).toEqual(["filed-1"]);
  });

  it("buckets a filed thread by its LAST ACTIVITY, not by when it was filed", () => {
    // Both directions. Filed 8 days ago but written to a minute ago by a
    // background agent: it sits with TODAY, where its activity is. Filed a
    // second ago but last active yesterday: it sits with YESTERDAY, the date
    // the user would name — the completion click must not drag it to TODAY.
    const threads = [
      thread("fresh", { latestAttentionAt: NOW - 60_000, updatedAt: NOW - 60_000 }),
      thread("stale", { latestAttentionAt: NOW - DAY_MS }),
    ];
    const model = buildListModel(
      input(threads, {
        completedAt: filed({ fresh: NOW - 8 * DAY_MS, stale: NOW - 1000 }),
        collapsedSections: expand("completed:today", "completed:yesterday"),
      }),
    );
    // The empty `yesterday` header comes with it: the bucket owns the subgroup.
    expect(keys(model)).toEqual([
      "today",
      "completed:today",
      "yesterday",
      "completed:yesterday",
    ]);
    expect(sequence(model)).toEqual(["fresh", "stale"]);
  });

  it("keeps a thread that blocks on the user OUT of any subgroup (B86.2)", () => {
    const threads = [thread("stuck", { hasPendingInteraction: true })];
    const model = buildListModel(
      input(threads, {
        sectionOrder: mount(threads),
        completedAt: filed({ stuck: NOW - 1000 }),
      }),
    );

    expect(keys(model)).toEqual(["needs-you"]);
  });

  it("moves a resumed thread to TODAY on its last activity, not its attention stamp", () => {
    // Started yesterday; the host's `latestAttentionAt` never advanced, but
    // the thread's newest event is a minute old. B82's timestamp is the
    // bucket date, so the thread walks out of YESTERDAY.
    const threads = [thread("resumed", { latestAttentionAt: NOW - DAY_MS })];
    const model = buildListModel(
      input(threads, {
        lastActivity: new Map([["resumed", NOW - 60_000]]),
      }),
    );
    expect(keys(model)).toEqual(["today", "working:today"]);
    expect(sequence(model)).toEqual(["resumed"]);
  });

  it("keeps the YESTERDAY bucket while a thread's activity is still unresolved", () => {
    // An id missing from the map is "not resolved yet", so the model falls
    // back to the attention stamp instead of yanking the thread to TODAY.
    const threads = [thread("quiet", { latestAttentionAt: NOW - DAY_MS })];
    const model = buildListModel(input(threads));
    expect(keys(model)).toEqual(["yesterday", "working:yesterday"]);
  });

  it("outranks the DONE band and the pin", () => {
    const threads = [
      thread("finished", { indicator: "unread-success" }),
      thread("pinned", { isPinned: true }),
    ];
    const model = buildListModel(
      input(threads, {
        sectionOrder: mount(threads),
        completedAt: filed({ finished: NOW - 1, pinned: NOW - 2 }),
        collapsedSections: expand("completed:today"),
      }),
    );
    expect(keys(model)).toEqual(["today", "completed:today"]);
  });

  it("takes the children of a filed parent with it", () => {
    const threads = [thread("parent"), thread("child", { parentThreadId: "parent" })];
    const model = buildListModel(
      input(threads, {
        sectionOrder: mount(threads),
        completedAt: filed({ parent: NOW - 1000 }),
        collapsedSections: expand("completed:today"),
        expandedThreadIds: new Set(["parent"]),
      }),
    );
    expect(keys(model)).toEqual(["today", "completed:today"]);
    expect(sequence(model)).toEqual(["parent", "child"]);
    // The child was never filed itself; only its parent was.
    expect(
      model.sections.find((s) => s.key === "completed:today")!.rows.map((r) => r.isCompleted),
    ).toEqual([
      true,
      false,
    ]);
  });

  it("orders a subgroup by most recently filed, not by entrance (B86.3)", () => {
    const threads = [thread("old"), thread("new"), thread("mid")];
    const model = buildListModel(
      input(threads, {
        sectionOrder: mount(threads),
        completedAt: filed({ old: NOW - 3000, new: NOW - 1000, mid: NOW - 2000 }),
        collapsedSections: expand("completed:today"),
      }),
    );
    expect(sequence(model)).toEqual(["new", "mid", "old"]);
  });

  it("follows every grouping mode's own groups", () => {
    const threads = [thread("a")];
    const expected: Record<string, string> = {
      project: "completed:project:p1",
      // Status mode IS a status split; B89 nests no subgroup inside one, so
      // the filed thread sits in its status group directly.
      status: "status:idle",
      none: "completed:all",
      date: "completed:today",
    };
    for (const [groupBy, key] of Object.entries(expected)) {
      const model = buildListModel(
        input(threads, {
          settings: { ...DEFAULT_SETTINGS, groupBy: groupBy as never },
          completedAt: filed({ a: NOW - 1 }),
          collapsedSections: key.startsWith("completed:")
            ? expand(key as SectionKey)
            : new Set<SectionKey>(),
        }),
      );
      expect(keys(model).at(-1)).toBe(key);
      expect(sequence(model)).toEqual(["a"]);
    }
  });

  it("dims its rows to the OLDER level rather than inventing a style", () => {
    const threads = [thread("a")];
    const model = buildListModel(
      input(threads, {
        completedAt: filed({ a: NOW - 1000 }),
        collapsedSections: expand("completed:today"),
      }),
    );
    expect(model.sections.at(-1)!.rows[0]!.dimLevel).toBe(3);
  });

  it("marks a filed thread in the search list, which has no section to say so", () => {
    const threads = [thread("alpha"), thread("beta")];
    const model = buildListModel(
      input(threads, {
        searchQuery: "alpha",
        completedAt: filed({ alpha: NOW - 1 }),
      }),
    );
    expect(keys(model)).toEqual(["search"]);
    expect(model.sections[0]!.rows[0]!.isCompleted).toBe(true);
  });

  it("raises the dot only for a write that lands AFTER the mark (B86.2)", () => {
    const threads = [
      thread("quiet", { updatedAt: NOW - 5000 }),
      thread("moved", { updatedAt: NOW - 500 }),
      thread("same", { updatedAt: NOW - 1000 }),
    ];
    const model = buildListModel(
      input(threads, {
        completedAt: filed({
          quiet: NOW - 1000,
          moved: NOW - 1000,
          same: NOW - 1000,
        }),
        collapsedSections: expand("completed:today"),
      }),
    );
    const dots = new Map(
      model.sections.at(-1)!.rows.map((row) => [
        row.thread.id,
        row.hasUpdateSinceCompleted,
      ]),
    );
    expect(dots.get("moved")).toBe(true);
    expect(dots.get("quiet")).toBe(false);
    // The write that RECORDS the mark lands on the same millisecond.
    expect(dots.get("same")).toBe(false);
  });
});

/**
 * B89. The WORKING subgroup is COMPLETED's live counterpart: the same
 * per-group nesting, but open by default (hiding running work would defeat
 * it), undimmed, and outranking COMPLETED — resuming a filed thread makes it
 * live work again. `showSubgroups` is the hard off-switch for both.
 */
describe("WORKING subgroups (B89)", () => {
  const filed = (ids: Record<string, number>) => new Map(Object.entries(ids));

  it("files a running thread in its group's WORKING subgroup, above COMPLETED", () => {
    const threads = [
      thread("busy", { indicator: "runtime" }),
      thread("a"),
      thread("filed", { indicator: "none" }),
    ];
    const model = buildListModel(
      input(threads, {
        completedAt: filed({ filed: NOW - 1000 }),
      }),
    );
    expect(keys(model)).toEqual([
      "today",
      "working:today",
      "completed:today",
    ]);
  });
  it("keeps a resumed filed thread in COMPLETED even while it runs", () => {
    // WORKING is the complement of COMPLETED: filing decides, the running
    // indicator does not pull a filed thread back out of the archive.
    const threads = [thread("resumed", { indicator: "background-agent" })];
    const model = buildListModel(
      input(threads, {
        completedAt: filed({ resumed: NOW - DAY_MS }),
      }),
    );
    expect(keys(model)).toEqual(["today", "completed:today"]);
  });

  it("leaves a pending working thread in needs-you (B1 outranks B89)", () => {
    const threads = [
      thread("stuck", { indicator: "runtime", hasPendingInteraction: true }),
    ];
    const model = buildListModel(input(threads));
    expect(keys(model)).toEqual(["needs-you"]);
  });

  it("keeps the WORKING header open and undimmed by default", () => {
    const threads = [thread("busy", { indicator: "workflow" })];
    const model = buildListModel(input(threads));
    const section = model.sections.find((s) => s.key === "working:today")!;
    expect(section.isCollapsed).toBe(false);
    expect(section.isSubgroup).toBe(true);
    expect(dimLevelFor(section.key)).toBe(0);
  });

  it("renders no subgroups at all when showSubgroups is off", () => {
    const threads = [
      thread("busy", { indicator: "runtime" }),
      thread("filed", { indicator: "none" }),
    ];
    const model = buildListModel(
      input(threads, {
        settings: { ...DEFAULT_SETTINGS, showSubgroups: false },
        completedAt: filed({ filed: NOW - 1000 }),
      }),
    );
    // Both threads fall back to the group's own rows; the filed one keeps its
    // row-level completed state, but no subgroup header exists.
    expect(keys(model)).toEqual(["today"]);
    expect(sequence(model)).toEqual(["busy", "filed"]);
  });
});
