import { describe, expect, it } from "vitest";
import type {
  PluginSidebarProject,
  PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { buildListModel, resolveTitle, resolveWorkspaceLabel } from "./list-model";
// The REAL freeze machine's snapshot, not a copy of it (F6). Every freeze test
// below drives useFreeze's own output into buildListModel, so the machine and
// the overlay can no longer diverge behind two agreeing stand-ins.
import { snapshot } from "../useFreeze";
import type { ListModelInput, ListModel, SectionKey } from "./types";

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
    settings: { groupBy: "date", secondRow: "auto", tooltip: "rich" },
    searchQuery: "",
    now: NOW,
    frozen: null,
    collapsedSections: new Set<SectionKey>(),
    collapsedThreadIds: new Set<string>(),
    ...overrides,
  };
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
          settings: { groupBy, secondRow: "auto", tooltip: "rich" },
        }),
      );
      expect(keys(model).slice(0, 2)).toEqual(["needs-you", "pinned"]);
      expect(sequence(model)).toEqual(["needs", "pin", "plain"]);
    }
  });

  it("replaces date buckets with one section per project", () => {
    const model = buildListModel(
      input(threads, {
        settings: { groupBy: "project", secondRow: "auto", tooltip: "rich" },
      }),
    );
    expect(keys(model)).toEqual(["needs-you", "pinned", "project:p2"]);
    expect(model.sections[2]!.label).toBe("BETA");
  });

  it("collapses everything else into one flat section for groupBy none", () => {
    const model = buildListModel(
      input(threads, {
        settings: { groupBy: "none", secondRow: "auto", tooltip: "rich" },
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

  it("keeps a section's count invariant across collapsing a subtree in it (B53.5)", () => {
    const threads = [
      thread("parent"),
      thread("child", { parentThreadId: "parent" }),
      thread("grandchild", { parentThreadId: "child" }),
      thread("other"),
    ];
    const expanded = buildListModel(input(threads));
    const collapsed = buildListModel(
      input(threads, { collapsedThreadIds: new Set(["parent"]) }),
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
          input(threads, { collapsedThreadIds: new Set(["parent"]) }),
        ),
      ),
    ).toEqual(["parent"]);
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
      ),
    ).toBe("wt");
    expect(
      resolveWorkspaceLabel(
        thread("a", {
          environment: { ...env, workspaceDisplayKind: "other" },
          host: { id: "h", name: "mac" },
        }),
      ),
    ).toBe("mac");
  });

  it("yields null for a null environment without throwing", () => {
    expect(resolveWorkspaceLabel(thread("a", { environment: null }))).toBeNull();
    expect(
      resolveWorkspaceLabel(
        thread("a", {
          environment: null,
          host: { id: "h", name: "mac" },
        }),
      ),
    ).toBeNull();
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

describe("freeze overlay (B6, §4 points 1-5)", () => {
  const base = [
    thread("a", { latestAttentionAt: NOW - 1000 }),
    thread("b", { latestAttentionAt: NOW - 2000 }),
    thread("c", { isPinned: true, latestAttentionAt: NOW - 3000 }),
  ];

  it("keeps a frozen id at its index when its attention overtakes the row above", () => {
    const frozen = snapshot(buildListModel(input(base)));
    expect(frozen.ids).toEqual(["c", "a", "b"]);
    const bumped = base.map((t) =>
      t.id === "b" ? thread("b", { latestAttentionAt: NOW }) : t,
    );
    expect(sequence(buildListModel(input(bumped)))).toEqual(["c", "b", "a"]);
    expect(sequence(buildListModel(input(bumped, { frozen })))).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("omits a vanished frozen id and closes the gap without re-sorting", () => {
    const frozen = snapshot(buildListModel(input(base)));
    const model = buildListModel(
      input(base.filter((t) => t.id !== "a"), { frozen }),
    );
    expect(sequence(model)).toEqual(["c", "b"]);
  });

  it("drops a section that emptied rather than rendering a bare header", () => {
    const frozen = snapshot(buildListModel(input(base)));
    const model = buildListModel(
      input(base.filter((t) => t.id !== "c"), { frozen }),
    );
    expect(keys(model)).toEqual(["today"]);
    expect(sequence(model)).toEqual(["a", "b"]);
  });

  it("lands a newly arriving needs-you thread at the very END of the whole list, moving nothing", () => {
    const before = buildListModel(input(base));
    const frozen = snapshot(before);
    const arrived = [
      ...base,
      thread("new", { hasPendingInteraction: true, latestAttentionAt: NOW + 5000 }),
    ];
    const after = buildListModel(input(arrived, { frozen }));
    const seq = sequence(after);
    // Every existing row's index is byte-identical; the newcomer is last.
    expect(seq.slice(0, frozen.ids.length)).toEqual([...frozen.ids]);
    expect(seq[frozen.ids.length]).toBe("new");
    // It gets no section header of its own while frozen.
    expect(keys(after)).toEqual(keys(before));
    // On release it takes its sorted position at the top of needs-you.
    expect(sequence(buildListModel(input(arrived)))).toEqual(["new", "c", "a", "b"]);
  });

  it("appends multiple newcomers in arrival order", () => {
    const frozen = snapshot(buildListModel(input(base)));
    const arrived = [
      ...base,
      thread("n1", { latestAttentionAt: NOW + 1 }),
      thread("n2", { latestAttentionAt: NOW + 9000 }),
    ];
    expect(sequence(buildListModel(input(arrived, { frozen })))).toEqual([
      "c",
      "a",
      "b",
      "n1",
      "n2",
    ]);
  });

  it("still pins the order of a search result list", () => {
    const searching = input(base, { searchQuery: "a" });
    const frozen = snapshot(buildListModel(searching));
    expect(frozen.sectionOrder).toEqual(["search"]);
    expect(sequence(buildListModel({ ...searching, frozen }))).toEqual([
      ...frozen.ids,
    ]);
  });

  it("renders live when no frozen row survives, instead of a hybrid order (F7)", () => {
    const frozen = snapshot(buildListModel(input(base)));
    const model = buildListModel(input([thread("z")], { frozen }));
    expect(sequence(model)).toEqual(["z"]);
    expect(keys(model)).toEqual(["today"]);
  });

  // --- F2/F3: structure is the live model's, order alone is the snapshot's ---

  it("keeps children directly beneath their parent when a subtree is expanded while frozen (F2)", () => {
    const threads = [
      thread("p", { latestAttentionAt: NOW - 1000 }),
      thread("kid1", { parentThreadId: "p", latestAttentionAt: NOW - 1100 }),
      thread("kid2", { parentThreadId: "p", latestAttentionAt: NOW - 1200 }),
      thread("tail", { latestAttentionAt: NOW - 5000 }),
    ];
    // Frozen while `p` is collapsed: the children are not in the snapshot at all.
    const collapsed = { collapsedThreadIds: new Set(["p"]) };
    const frozen = snapshot(buildListModel(input(threads, collapsed)));
    expect(frozen.ids).toEqual(["p", "tail"]);

    // The chevron is only reachable with the pointer over the list, so the
    // freeze is ALWAYS engaged when a subtree is expanded.
    const model = buildListModel(input(threads, { frozen }));

    expect(sequence(model)).toEqual(["p", "kid1", "kid2", "tail"]);
    const rows = model.sections[0]!.rows;
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 1, 0]);
    // The children are not newcomers: they must not be appended past `tail`.
    expect(sequence(model).indexOf("kid1")).toBeLessThan(
      sequence(model).indexOf("tail"),
    );
  });

  it("keeps a collapsed section present with its header and count while frozen (F3)", () => {
    const threads = [
      thread("t1"),
      thread("t2"),
      thread("old", { latestAttentionAt: NOW - 10 * DAY_MS }),
    ];
    const frozen = snapshot(buildListModel(input(threads)));
    expect(keys(buildListModel(input(threads)))).toEqual(["today", "last-30"]);

    const model = buildListModel(
      input(threads, { frozen, collapsedSections: new Set<SectionKey>(["today"]) }),
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

  it("takes section metadata from the live model, not from the snapshot", () => {
    // `late` moves from `today` into `last-30` only in the live model; the
    // header, its label and its count all come from that live section.
    const threads = [thread("a"), thread("late")];
    const frozen = snapshot(buildListModel(input(threads)));
    const model = buildListModel(
      input(
        [thread("a"), thread("late", { latestAttentionAt: NOW - 10 * DAY_MS })],
        { frozen },
      ),
    );
    for (const section of model.sections) {
      expect(section.label).toBe(section.key === "today" ? "TODAY" : "LAST 30 DAYS");
    }
    // Nothing already rendered moved: `a` is still first.
    expect(sequence(model)[0]).toBe("a");
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
