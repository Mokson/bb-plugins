// The Observatory panel's frontend entry.
//
// One nav panel, one settings section, one thread tab, one sidebar strip.
// Path owns identity: the tab strip navigates, so a route is a URL the reader
// can keep, not component state. Nothing under `src/app/` imports the store or
// better-sqlite3; the only crossings are the type-only imports of
// `../contract.js` and `../spend/contract.js`.
import type { PluginThreadPanelProps } from "@get-bb/plugin-sdk";
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ObservatoryPanel, PANEL_PATH } from "./pages/panel.js";
import { ObservatorySettings } from "./pages/settings.js";
import { ThreadCost } from "./pages/thread-cost.js";
import { ThreadContext } from "./pages/context.js";
import { ThreadAudit } from "./pages/audit-sessions.js";
import { mountSidebarUsageStrip } from "./lib/usage/sidebar-strip.js";
import "./usage-strip.css";

/** The thread panel's tabs, each rendering the panel route's own component. */
function ThreadCostTab({ threadId }: PluginThreadPanelProps) {
  return <ThreadCost threadId={threadId} />;
}

function ThreadContextTab({ threadId }: PluginThreadPanelProps) {
  return <ThreadContext threadId={threadId} />;
}

function ThreadAuditTab({ threadId }: PluginThreadPanelProps) {
  return <ThreadAudit threadId={threadId} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "observatory",
    title: "Observatory",
    icon: "Eye",
    path: PANEL_PATH,
    component: ObservatoryPanel,
  });

  // The same read-only display the panel's settings route shows, mounted on
  // the plugin detail page beneath bb's own editable form.
  app.slots.settingsSection({
    id: "observatory-settings",
    title: "Observatory",
    description: "Module states as the plugin currently reads them.",
    component: ObservatorySettings,
  });

  // The per-thread Cost tab. The launcher opens it; the same content is
  // reachable at the panel route `threads/<id>`.
  app.slots.threadPanelAction({
    id: "observatory-cost",
    title: "Cost",
    icon: "Eye",
    component: ThreadCostTab,
  });

  // The same thread read two more ways: what its window is made of, and how
  // this session compares with the last seven days of sessions.
  app.slots.threadPanelAction({
    id: "observatory-context",
    title: "Context",
    icon: "Eye",
    component: ThreadContextTab,
  });

  app.slots.threadPanelAction({
    id: "observatory-audit",
    title: "Audit",
    icon: "Eye",
    component: ThreadAuditTab,
  });

  // The absorbed usage-tracker strip plus today's spend. It is a content
  // script rather than a `sidebarFooterAction` because that slot is
  // host-rendered - an icon button with a `run` callback and no component -
  // and cannot paint provider limits or a number.
  app.contentScripts.register({
    id: "observatory-sidebar-strip",
    mount: ({ signal }) => mountSidebarUsageStrip(signal),
  });
});
