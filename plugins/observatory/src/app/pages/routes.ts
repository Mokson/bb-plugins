// The panel's route table, kept free of the SDK app runtime so tests (and the
// tab strip) can name routes without evaluating `@get-bb/plugin-sdk/app`
// before the harness installs its runtime.

/**
 * The nav panel's path. It lives here rather than in `panel.tsx` so a page can
 * navigate without importing the shell that renders it.
 */
export const PANEL_PATH = "observatory";

/** The routes the tab strip offers. `""` is the inbox and is always first. */
export const ROUTES = [
  { id: "", title: "Inbox" },
  { id: "cost", title: "Cost" },
  { id: "stalls", title: "Stalls" },
  { id: "context", title: "Context" },
  { id: "audit", title: "Audit" },
  { id: "eval", title: "Eval" },
  { id: "distillery", title: "Distillery" },
  { id: "settings", title: "Settings" },
] as const;

/** The Audit tab's own three routes, addressed as `audit/<id>`. */
export const AUDIT_ROUTES = [
  { id: "sessions", title: "Sessions" },
  { id: "failures", title: "Failures" },
  { id: "insights", title: "Insights" },
] as const;

/**
 * What each not-yet-built route will hold, one line each. `cost`, `context`
 * and `audit` are absent: they are built, so a placeholder for one of them
 * would be a second, wrong answer.
 */
export const PLACEHOLDERS: Record<string, string> = {
  stalls: "Stall rules, the steer ladder and tree budget. Phases 2 and 3.",
  eval: "Deliver-stack regression cases and baselines. Phase 5.",
  distillery: "Correction mining and the draft review queue. Phase 6.",
};
