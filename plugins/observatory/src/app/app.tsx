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
import { Trajectory } from "./pages/trajectory.js";
import { NavAccessory } from "./components/nav-accessory.js";
import { StallBanner } from "./components/stall-banner.js";
import { mountSidebarUsageStrip } from "./lib/usage/sidebar-strip.js";
import { mountThreadRowStatus } from "./lib/watch/thread-row-status.js";
import "./usage-strip.css";

/** The thread panel's Cost tab, rendering the panel route's own component. */
function ThreadCostTab({ threadId }: PluginThreadPanelProps) {
  return <ThreadCost threadId={threadId} />;
}

/** The thread panel's Trajectory tab, over the same component as the route. */
function TrajectoryTab({ threadId }: PluginThreadPanelProps) {
  return <Trajectory threadId={threadId} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "observatory",
    title: "Observatory",
    icon: "Eye",
    path: PANEL_PATH,
    component: ObservatoryPanel,
    // Two counts on the sidebar row, so the reason to open the panel is
    // visible without opening it. It renders nothing when both are zero.
    experimental_sidebarAccessory: NavAccessory,
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

  // The per-thread Trajectory tab, reachable the same two ways as Cost: the
  // launcher, and the panel route `threads/<id>/trajectory`.
  app.slots.threadPanelAction({
    id: "observatory-trajectory",
    title: "Trajectory",
    icon: "Eye",
    component: TrajectoryTab,
  });

  // One line on a stalled thread's composer, with the trajectory one click
  // away. `bare` chrome because the banner is a sentence, not a card, and a
  // card around one line is the box PRODUCT invariant 34 rules out.
  app.composer.customize({
    id: "observatory-stall-banner",
    scopes: ["thread", "queued-message", "side-chat"],
    banners: [
      { id: "observatory-stalled", chrome: "bare", component: StallBanner },
    ],
  });

  // The absorbed usage-tracker strip plus today's spend. It is a content
  // script rather than a `sidebarFooterAction` because that slot is
  // host-rendered - an icon button with a `run` callback and no component -
  // and cannot paint provider limits or a number.
  app.contentScripts.register({
    id: "observatory-sidebar-strip",
    mount: ({ signal }) => mountSidebarUsageStrip(signal),
  });

  // Thread rows carry an open watch signal. It is a content script because
  // `experimental_setThreadRowStatus` lives on the content-script context and
  // nowhere else.
  app.contentScripts.register({
    id: "observatory-thread-row-status",
    mount: (context) => mountThreadRowStatus(context),
  });
});
