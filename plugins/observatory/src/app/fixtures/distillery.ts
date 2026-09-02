// Synthetic distillery data for `?fixture=1`.
//
// Every id here starts `draft_fixture_`, `cluster_fixture_` or names a fixture
// run folder, so a screenshot taken from this data cannot be mistaken for a
// real queue. The three drafts cover the shapes the page has to render: a
// patch draft, a rule-text-only draft, and a prose-rung draft that must show
// the stronger-rung line.
import type { DistilleryData } from "@/lib/distillery-rpc";

const PATCH = `--- a/skills/deliver/craft-build.md
+++ b/skills/deliver/craft-build.md
@@ -18,6 +18,9 @@
 Run the scoped check before you hand back.

+A seat that adds an async call adds its error path and its teardown in the
+same edit. A subscription without a matching teardown is an incomplete edit,
+not a follow-up.
+
 Cite file:line for every claim.`;

export function fixtureDistillery(): DistilleryData {
  return {
    status: {
      pending: 3,
      accepted: 7,
      applied: 4,
      rejected: 2,
      clusters: 9,
      topClusters: [
        {
          signature: "async call added without a teardown",
          cause_class: "built-wrong",
          size: 6,
          runs: 4,
        },
        {
          signature: "seat re-derived a packet fact from the repo",
          cause_class: "instruction-miss",
          size: 4,
          runs: 3,
        },
        {
          signature: "full suite run before the scoped check",
          cause_class: "over-verification",
          size: 3,
          runs: 2,
        },
      ],
      monthSpendUsd: 2.84,
      budgetUsd: 20,
    },
    rows: [
      {
        draft: {
          id: "draft_fixture_1",
          clusterId: "cluster_fixture_1",
          state: "pending",
          homeFile: "skills/deliver/craft-build.md",
          rung: 1,
          patchUnifiedDiff: PATCH,
          ruleText: null,
          successSignal: "no review finding names a missing teardown for 3 runs",
          rationale:
            "Six seats across four runs added a subscription with no teardown; the review caught each one after the commit.",
          evidenceIds: [101, 102, 103],
          recurrence: 2,
          createdAt: "2026-08-30T09:12:00.000Z",
          updatedAt: "2026-08-30T09:12:00.000Z",
          appliedPath: null,
          threadId: "thr_fixture_distill_1",
        },
        cluster: {
          id: "cluster_fixture_1",
          signature: "async call added without a teardown",
          causeClass: "built-wrong",
          size: 6,
          runs: 4,
          firstAt: "2026-08-11T10:00:00.000Z",
          lastAt: "2026-08-29T18:40:00.000Z",
          status: "drafted",
        },
        evidence: [
          {
            id: 101,
            source: "review-finding",
            signature: "async call added without a teardown",
            causeClass: "built-wrong",
            preview:
              "useEffect subscribes to the run store and never unsubscribes; a second mount leaks the listener.",
            redactionCounts: { path: 2 },
            runFolder: "runs/fixture-run-a",
            threadId: "thr_fixture_a",
            at: "2026-08-29T18:40:00.000Z",
            confidence: 0.82,
            clusterId: "cluster_fixture_1",
          },
          {
            id: 102,
            source: "ledger-nudge",
            signature: "async call added without a teardown",
            causeClass: "built-wrong",
            preview:
              "Max: you added the listener without the cleanup again, fold it into the same edit.",
            redactionCounts: {},
            runFolder: "runs/fixture-run-b",
            threadId: "thr_fixture_b",
            at: "2026-08-22T11:05:00.000Z",
            confidence: 0.95,
            clusterId: "cluster_fixture_1",
          },
        ],
      },
      {
        draft: {
          id: "draft_fixture_2",
          clusterId: "cluster_fixture_2",
          state: "pending",
          homeFile: "skills/deliver/handoffs.md",
          rung: 4,
          patchUnifiedDiff: null,
          ruleText:
            "A packet fact the seat re-derives from the repo is a wasted dispatch. State the branch, the seam path and the fixture home in the packet, and have the seat stop on a missing field rather than infer it.",
          successSignal: "no seat return reports a re-derived packet fact",
          rationale:
            "Four seats across three runs opened the same files the packet already named.",
          evidenceIds: [110, 111],
          recurrence: 1,
          createdAt: "2026-08-31T07:00:00.000Z",
          updatedAt: "2026-08-31T07:00:00.000Z",
          appliedPath: null,
          threadId: "thr_fixture_distill_2",
        },
        cluster: {
          id: "cluster_fixture_2",
          signature: "seat re-derived a packet fact from the repo",
          causeClass: "instruction-miss",
          size: 4,
          runs: 3,
          firstAt: "2026-08-14T09:00:00.000Z",
          lastAt: "2026-08-30T16:20:00.000Z",
          status: "drafted",
        },
        evidence: [
          {
            id: 110,
            source: "retro-finding",
            signature: "seat re-derived a packet fact from the repo",
            causeClass: "instruction-miss",
            preview:
              "Seat spent 14 tool calls locating the contract module the packet had already named.",
            redactionCounts: { home: 1 },
            runFolder: "runs/fixture-run-c",
            threadId: "thr_fixture_c",
            at: "2026-08-30T16:20:00.000Z",
            confidence: 0.7,
            clusterId: "cluster_fixture_2",
          },
        ],
      },
      {
        draft: {
          id: "draft_fixture_3",
          clusterId: "cluster_fixture_3",
          state: "pending",
          homeFile: null,
          rung: null,
          patchUnifiedDiff: null,
          ruleText:
            "Run the scoped check first; the full suite is a gate, not a loop.",
          successSignal: null,
          rationale: null,
          evidenceIds: [120],
          recurrence: 0,
          createdAt: "2026-09-01T12:00:00.000Z",
          updatedAt: "2026-09-01T12:00:00.000Z",
          appliedPath: null,
          threadId: null,
        },
        cluster: null,
        evidence: [
          {
            id: 120,
            source: "transcript",
            signature: "full suite run before the scoped check",
            causeClass: "over-verification",
            preview:
              "Seat ran the whole vitest suite three times before narrowing to one file.",
            redactionCounts: {},
            runFolder: "runs/fixture-run-d",
            threadId: "thr_fixture_d",
            at: "2026-09-01T11:40:00.000Z",
            confidence: 0.45,
            clusterId: null,
          },
        ],
      },
    ],
  };
}
