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

// Every route in `ROUTES` is built, so there is no placeholder table here.
// An address outside the table is a bad address, and `panel.tsx` says so
// rather than promising a page that is on its way.
