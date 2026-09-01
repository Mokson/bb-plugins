// Synthetic context and audit data for `?fixture=1`.
//
// Same rule as `fixtures/spend.ts`: every name says "fixture" and every id
// starts `thr_fixture_`, so a screenshot taken from this data can never be
// mistaken for a real project's prefix or a real bill. It exists to render
// the pages - composition, duplicates, nulls, medians, mutes - without a live
// database, and it is typed against the shipped contracts so a contract change
// breaks it loudly.
import type {
  ContextThreadView,
  ContextView,
} from "../../context/contract.js";
import type {
  AuditFailureRow,
  AuditInsightFacet,
  AuditSessionRow,
  AuditSessionView,
} from "../../audit/contract.js";

export const FIXTURE_CONTEXT_THREAD_ID = "thr_fixture_1";

export function fixtureContextView(): ContextView {
  return {
    snapshot: {
      id: 1,
      projectId: "prj_fixture",
      cwd: "/fixture/project",
      takenAt: "2026-09-01T09:00:00.000Z",
      provider: "claude",
      totalEstTokens: 48_200,
      calibrationFactor: 1.08,
      calibrationError: 0.031,
    },
    composition: [
      { surface: "instruction", estTokens: 19_800, share: 0.4108 },
      { surface: "skill", estTokens: 15_400, share: 0.3195 },
      { surface: "mcp", estTokens: 9_100, share: 0.1888 },
      { surface: "plugin-tool", estTokens: 3_900, share: 0.0809 },
    ],
    blocks: [
      {
        surface: "instruction",
        path: "/fixture/project/CLAUDE.md",
        name: "fixture CLAUDE.md",
        bytes: 41_200,
        estTokens: 12_400,
        hash: "f1",
        duplicateOf: null,
        dead: false,
      },
      {
        surface: "instruction",
        path: "/fixture/home/AGENTS.md",
        name: "fixture AGENTS.md",
        bytes: 24_600,
        estTokens: 7_400,
        hash: "f2",
        duplicateOf: "fixture CLAUDE.md",
        dead: false,
      },
      {
        surface: "skill",
        path: "/fixture/skills/deliver/SKILL.md",
        name: "fixture deliver skill",
        bytes: 32_000,
        estTokens: 9_600,
        hash: "f3",
        duplicateOf: null,
        dead: false,
      },
      {
        surface: "skill",
        path: "/fixture/skills/archive/SKILL.md",
        name: "fixture archive skill",
        bytes: 19_300,
        estTokens: 5_800,
        hash: "f4",
        duplicateOf: null,
        dead: true,
      },
      {
        surface: "mcp",
        path: null,
        name: "fixture mcp tools",
        bytes: 30_300,
        estTokens: 9_100,
        hash: "f5",
        duplicateOf: null,
        dead: false,
      },
      {
        surface: "plugin-tool",
        path: null,
        name: "fixture plugin tools",
        bytes: 13_000,
        estTokens: 3_900,
        hash: "f6",
        duplicateOf: null,
        dead: false,
      },
    ],
    duplicates: [
      {
        a: "fixture CLAUDE.md",
        b: "fixture AGENTS.md",
        overlap: 0.62,
        recoverableTokens: 4_580,
      },
    ],
    dead: [
      {
        name: "fixture archive skill",
        path: "/fixture/skills/archive/SKILL.md",
        bytes: 19_300,
      },
    ],
  };
}

export function fixtureContextThread(): ContextThreadView {
  return {
    threadId: FIXTURE_CONTEXT_THREAD_ID,
    contextUsed: 118_400,
    contextWindow: 200_000,
    historyShare: 0.59,
    toolResultShare: 0.34,
    compactionEstimateTokens: 42_100,
    snapshotId: 1,
  };
}

export function fixtureAuditSessions(): { rows: AuditSessionRow[] } {
  return {
    rows: [
      {
        threadId: "thr_fixture_1",
        title: "fixture deliver run",
        seat: "implement",
        runFolder: "/fixture/runs/2026-09-01",
        turns: 84,
        toolCalls: 212,
        tokens: 1_284_000,
        costUsd: 24.61,
        wallMs: 5_412_000,
        providerErrors: 2,
        compactions: 1,
      },
      {
        threadId: "thr_fixture_2",
        title: "fixture qa seat",
        seat: "qa",
        runFolder: null,
        turns: 31,
        toolCalls: 74,
        tokens: 402_000,
        costUsd: null,
        wallMs: 1_180_000,
        providerErrors: 0,
        compactions: 0,
      },
    ],
  };
}

export function fixtureAuditSession(): AuditSessionView {
  return {
    threadId: "thr_fixture_1",
    runFolder: "/fixture/runs/2026-09-01",
    threads: ["thr_fixture_1", "thr_fixture_2"],
    metrics: [
      { metric: "turns", value: 84, median: 61, delta: 0.377 },
      { metric: "tool calls", value: 212, median: 240, delta: -0.117 },
      { metric: "tokens", value: 1_284_000, median: 980_000, delta: 0.31 },
      { metric: "cost usd", value: 24.61, median: null, delta: null },
    ],
    verification: {
      commands: 46,
      verificationCommands: 0,
      lastVerifiedAt: null,
      textAvailable: false,
    },
    unverifiedEdits: [
      {
        itemId: "itm_fixture_1",
        path: "/fixture/project/src/app/pages/context.tsx",
        at: "2026-09-01T10:12:00.000Z",
      },
    ],
    findings: [
      {
        code: "no-verification",
        detail: "fixture run ran 46 commands and none matched a check",
      },
    ],
  };
}

export function fixtureAuditFailures(): { rows: AuditFailureRow[] } {
  return {
    rows: [
      {
        signature: "fixture-provider-overloaded",
        category: "provider",
        message: "fixture provider returned 529 overloaded",
        count: 14,
        firstSeen: "2026-08-28T08:00:00.000Z",
        lastSeen: "2026-09-01T07:40:00.000Z",
        threads: ["thr_fixture_1", "thr_fixture_2"],
        muted: false,
        mutedUntil: null,
      },
      {
        signature: "fixture-tool-timeout",
        category: "tool",
        message: "fixture bash call exceeded its timeout",
        count: 3,
        firstSeen: "2026-08-30T11:20:00.000Z",
        lastSeen: "2026-08-31T16:05:00.000Z",
        threads: ["thr_fixture_1"],
        muted: true,
        mutedUntil: "2026-09-07T00:00:00.000Z",
      },
    ],
  };
}

export function fixtureAuditInsights(): { facets: AuditInsightFacet[] } {
  return {
    facets: [
      {
        facet: "failures-by-signature",
        unit: "count",
        rows: [
          {
            label: "fixture-provider-overloaded",
            value: 14,
            share: 0.82,
            actionable: true,
          },
          {
            label: "fixture-tool-timeout",
            value: 3,
            share: 0.18,
            actionable: false,
          },
        ],
      },
      {
        facet: "cost-by-seat",
        unit: "usd",
        rows: [
          { label: "implement", value: 24.61, share: 0.61, actionable: true },
          { label: "qa", value: 9.4, share: 0.23, actionable: false },
          { label: "review", value: 6.5, share: 0.16, actionable: false },
        ],
      },
      {
        facet: "cost-by-model",
        unit: "usd",
        rows: [
          {
            label: "claude-opus-5",
            value: 31.2,
            share: 0.77,
            actionable: true,
          },
          {
            label: "claude-sonnet-5",
            value: 9.31,
            share: 0.23,
            actionable: false,
          },
        ],
      },
    ],
  };
}
