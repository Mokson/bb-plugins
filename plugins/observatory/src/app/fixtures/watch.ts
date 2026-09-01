// Synthetic watch data for `?fixture=1`.
//
// Every id starts `thr_fixture_`, `sig_fixture_` or `act_fixture_` and every
// title says "fixture", so a screenshot taken from this data can never be
// mistaken for a real stall. It exists to render the inbox, the stall monitor,
// the trajectory tab and the settings page before the server half lands, and
// it is typed against the shipped contract so a contract change breaks it
// loudly.
//
// The stamps are relative to `now` rather than fixed: a stall is a duration,
// and a fixture frozen in 2026 would render "14 months silent" forever.
import type {
  Inbox,
  WatchExplain,
  WatchList,
  WatchSettings,
  WatchSignals,
} from "../../watch/contract.js";

export const FIXTURE_THREAD_ID = "thr_fixture_1";
const MINUTE = 60_000;

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * MINUTE).toISOString();
}

export function fixtureWatchList(): WatchList {
  return {
    watched: 4,
    rows: [
      {
        threadId: FIXTURE_THREAD_ID,
        title: "fixture deliver run",
        seat: "implement",
        state: "stalled",
        silentMs: 14 * MINUTE,
        inflight: null,
        stage: "implement",
        rule: "silence-no-inflight",
        diagnostic:
          "no item for 14m with nothing in flight; the last command was the test run",
        openedAt: ago(14),
      },
      {
        threadId: "thr_fixture_2",
        title: "fixture implement seat",
        seat: "implement",
        state: "stalled",
        silentMs: 6 * MINUTE,
        inflight: { kind: "command", name: "npm test -- watch" },
        stage: "verify",
        rule: "repeated-identical-tool",
        diagnostic: "same test command 6 times inside the last 20 items",
        openedAt: ago(6),
      },
      {
        threadId: "thr_fixture_3",
        title: "fixture qa seat",
        seat: "qa",
        state: "healthy",
        silentMs: 21_000,
        inflight: { kind: "tool", name: "Read" },
        stage: "explore",
        rule: null,
        diagnostic: null,
        openedAt: null,
      },
      {
        threadId: "thr_fixture_4",
        title: "fixture review seat",
        seat: "review",
        state: "healthy",
        silentMs: 4_000,
        inflight: null,
        stage: null,
        rule: null,
        diagnostic: null,
        openedAt: null,
      },
    ],
  };
}

export function fixtureInbox(): Inbox {
  return {
    counts: { watched: 4, stalled: 2, overBudget: 1, queue: 3 },
    rows: [
      {
        id: "sig_fixture_1",
        source: "watch",
        kind: "stalled",
        title: "fixture deliver run",
        subtitle:
          "no item for 14m with nothing in flight; the last command was the test run",
        threadId: FIXTURE_THREAD_ID,
        severity: "high",
        openedAt: ago(14),
        actions: ["open", "steer", "escalate"],
      },
      {
        id: "sig_fixture_2",
        source: "spend",
        kind: "over-budget",
        title: "fixture deliver run subtree",
        subtitle: "subtree at 62.40 usd against a 50.00 usd tree budget",
        threadId: FIXTURE_THREAD_ID,
        severity: "high",
        openedAt: ago(31),
        actions: ["open", "escalate"],
      },
      {
        id: "sig_fixture_3",
        source: "watch",
        kind: "repeated-identical-tool",
        title: "fixture implement seat",
        subtitle: "same test command 6 times inside the last 20 items",
        threadId: "thr_fixture_2",
        severity: "warn",
        openedAt: ago(6),
        actions: ["open", "steer"],
      },
      {
        id: "sig_fixture_4",
        source: "distillery",
        kind: "draft-ready",
        title: "fixture correction draft",
        subtitle: "3 corrections mined from yesterday's runs await review",
        threadId: null,
        severity: "info",
        openedAt: ago(240),
        actions: ["review"],
      },
    ],
  };
}

export function fixtureWatchExplain(): WatchExplain {
  return {
    threadId: FIXTURE_THREAD_ID,
    signals: [
      {
        id: "sig_fixture_1",
        kind: "silence-no-inflight",
        severity: "high",
        openedAt: "2026-09-01T09:10:00.000Z",
        closedAt: null,
        evidence:
          "no item for 14m with nothing in flight; the last command was the test run",
        payload: { silentMs: 840_000, lastItem: "npm test" },
      },
      {
        id: "sig_fixture_2",
        kind: "repeated-identical-tool",
        severity: "warn",
        openedAt: "2026-09-01T09:03:00.000Z",
        closedAt: "2026-09-01T09:09:00.000Z",
        evidence: "same test command 6 times inside the last 20 items",
        payload: { command: "npm test", count: 6 },
      },
      {
        id: "sig_fixture_3",
        kind: "read-edit-read-oscillation",
        severity: "warn",
        openedAt: "2026-09-01T09:03:30.000Z",
        closedAt: "2026-09-01T09:08:00.000Z",
        evidence: "two read-edit-read cycles over src/core/join.ts, no command between",
        payload: { path: "src/core/join.ts", cycles: 2 },
      },
      {
        id: "sig_fixture_4",
        kind: "prefix-changed",
        severity: "info",
        openedAt: "2026-09-01T09:07:00.000Z",
        closedAt: "2026-09-01T09:07:30.000Z",
        evidence: "request fingerprint changed: claude-opus-5 to claude-sonnet-5",
        payload: { from: "claude-opus-5", to: "claude-sonnet-5" },
      },
    ],
    actions: [
      {
        id: "act_fixture_1",
        action: "record",
        at: "2026-09-01T09:03:00.000Z",
        detail: "rung 0, watch mode is observe so nothing was sent",
      },
    ],
  };
}

export function fixtureWatchSignals(): WatchSignals {
  const explain = fixtureWatchExplain();
  return {
    rows: explain.signals
      .filter((signal) => signal.closedAt === null)
      .map((signal) => ({ ...signal, threadId: FIXTURE_THREAD_ID })),
  };
}

export function fixtureWatchSettings(): WatchSettings {
  return {
    mode: "observe",
    thresholds: {
      budget_perDayUsd: 500,
      budget_perTreeUsd: 50,
      rule_activeNoTurnMinutes: 10,
      rule_burnNoChangeTokens: 150_000,
      rule_oscillationCycles: 2,
      rule_repeatedToolCount: 3,
      rule_retryStormCount: 3,
      rule_silenceMinutes: 4,
    },
    source: {
      budget_perDayUsd: "setting",
      budget_perTreeUsd: "kv",
      rule_activeNoTurnMinutes: "setting",
      rule_burnNoChangeTokens: "setting",
      rule_oscillationCycles: "setting",
      rule_repeatedToolCount: "kv",
      rule_retryStormCount: "setting",
      rule_silenceMinutes: "setting",
    },
  };
}
