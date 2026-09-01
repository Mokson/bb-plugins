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

/**
 * What each not-yet-built route will hold, one line each. `cost` and `stalls`
 * are absent: they are built, so a placeholder for either would be a second,
 * wrong answer.
 */
export const PLACEHOLDERS: Record<string, string> = {
  context: "Instruction, skill and MCP composition audit. Phase 4.",
  audit: "Session metrics, failure ledger and the audit pack. Phase 4.",
  eval: "Deliver-stack regression cases and baselines. Phase 5.",
  distillery: "Correction mining and the draft review queue. Phase 6.",
};
