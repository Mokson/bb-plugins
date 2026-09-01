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
    projectFilter: null,
    localHostId: null,
    sectionOrder: null,
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
  showEffort: false,
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
    expect(keys(model)).toEqual(["needs-you", "pinned", "today", "last-30"]);
  });

  it("produces no RenderSection for a bucket with no threads", () => {
    const model = buildListModel(input([thread("a")]));
    expect(keys(model)).toEqual(["today"]);
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
    expect(keys(model)).toEqual(["needs-you", "pinned", "project:p2"]);
    expect(model.sections[2]!.label).toBe("BETA");
  });

  it("collapses everything else into one flat section for groupBy none", () => {
    const model = buildListModel(
      input(threads, {
        settings: { ...DEFAULT_SETTINGS, groupBy: "none" },
      }),
    );
    expect(keys(model)).toEqual(["needs-you", "pinned", "all"]);
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

    expect(buildListModel(input(roots)).sections[0]!.count).toBe(2);
    const busy = buildListModel(input(withSubagents));
    expect(busy.sections[0]!.count).toBe(2);
    expect(busy.sections[0]!.rows).toHaveLength(18);
    // The volume is reported where it belongs: on the parent (B53.2).
    expect(busy.sections[0]!.rows[0]!.childCount).toBe(16);
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

    expect(expanded.sections[0]!.rows).toHaveLength(4);
    expect(collapsed.sections[0]!.rows).toHaveLength(2);
    expect(collapsed.sections[0]!.count).toBe(expanded.sections[0]!.count);
    expect(expanded.sections[0]!.count).toBe(2);
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
    expect(model.sections[0]!.rows[0]!.childCount).toBe(0);
  });

  it("treats a thread whose parent is absent as its own root", () => {
    const model = buildListModel(input([thread("orphan", { parentThreadId: "gone" })]));
    expect(sequence(model)).toEqual(["orphan"]);
    expect(model.sections[0]!.rows[0]!.depth).toBe(0);
  });

  it("keeps the count of a collapsed section while emitting no rows", () => {
    const model = buildListModel(
      input([thread("a"), thread("b")], {
        collapsedSections: new Set<SectionKey>(["today"]),
      }),
    );
    expect(model.sections[0]!.count).toBe(2);
    expect(model.sections[0]!.isCollapsed).toBe(true);
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
    expect(model.sections[0]!.rows[0]!.title).toBe("Fallback");
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
    expect(keys(model)).toEqual(["needs-you", "pinned", "today"]);
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
    expect(keys(model)).toEqual(["today"]);
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
    expect(model.sections[0]!.rows.map((row) => row.depth)).toEqual([0, 1, 1, 0]);
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
        collapsedSections: new Set<SectionKey>(["today"]),
      }),
    );

    const today = model.sections.find((section) => section.key === "today");
    expect(today).toBeDefined();
    expect(today!.isCollapsed).toBe(true);
    expect(today!.label).toBe("TODAY");
    expect(today!.count).toBe(2);
    expect(today!.rows).toEqual([]);
    expect(keys(model)).toEqual(["today", "last-30"]);
    expect(sequence(model)).toEqual(["old"]);
  });

  it("takes section membership from the live model, never from the sequence map", () => {
    // `late` ages out of `today` into `last-30`. The sequence map still holds
    // its OLD section, and the live model's answer must win — inverting this
    // is what shipped a blocker in the overlay this replaces.
    const threads = [thread("a"), thread("late")];
    const stale = mount(threads);
    expect(stale.entries.get("late")!.section).toBe("today");
    const aged = [thread("a"), thread("late", { latestAttentionAt: NOW - 10 * DAY_MS })];
    const model = buildListModel(input(aged, { sectionOrder: stale }));
    expect(keys(model)).toEqual(["today", "last-30"]);
    expect(model.sections[1]!.rows.map((row) => row.thread.id)).toEqual(["late"]);
    for (const section of model.sections) {
      expect(section.label).toBe(section.key === "today" ? "TODAY" : "LAST 30 DAYS");
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
    expect(keys(model)).toEqual(["needs-you", "done", "pinned", "today"]);
    const done = model.sections.find((section) => section.key === "done")!;
    expect(done.rows.map((row) => row.thread.id).sort()).toEqual(["failed", "finished"]);
    expect(done.label).toBe("DONE");
    expect(done.isCollapsible).toBe(true);
  });

  it("leaves a thread that is unread but still running out of DONE (B67.1)", () => {
    const threads = [thread("running", { indicator: "runtime", isUnread: true })];
    expect(keys(buildListModel(input(threads)))).toEqual(["today"]);
  });

  it("never promotes a parent for a completed CHILD (B67.3)", () => {
    const threads = [
      thread("parent"),
      thread("child", { parentThreadId: "parent", indicator: "unread-success" }),
    ];
    const model = buildListModel(input(threads, { sectionOrder: mount(threads) }));
    // One section, and the child is still nested where it already was.
    expect(keys(model)).toEqual(["today"]);
    expect(model.sections[0]!.rows.map((row) => row.depth)).toEqual([0, 1]);
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
    expect(keys(model)).toEqual(["host:h1", "host:h2", "host:none"]);
    expect(model.sections.map((section) => section.label)).toEqual([
      "ALPHA",
      "ZETA",
      "NO MACHINE",
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
    expect(model.sections[0]!.count).toBe(1);
    expect(model.sections[0]!.rows).toHaveLength(2);
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
    expect(keys(model)).toEqual(["today"]);
  });

  it("does not change band precedence (B64.6)", () => {
    const model = buildListModel(
      input(mixed, { projectFilter: "p2", sectionOrder: mount(mixed) }),
    );
    expect(keys(model)).toEqual(["pinned", "today"]);
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
    expect(model.sections[0]!.rows.every((row) => row.depth === 0)).toBe(true);
    expect(model.sections[0]!.count).toBe(2);
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
    expect(model.sections[0]!.rows[1]!.depth).toBe(1);
  });
});
