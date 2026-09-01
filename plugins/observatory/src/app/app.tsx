// The Observatory panel's frontend entry.
//
// One nav panel, one settings section, nothing else. Path owns identity: the
// tab strip navigates, so a route is a URL the reader can keep, not component
// state. Nothing under `src/app/` imports the store or better-sqlite3; the
// single legal crossing is the type-only import of `../contract.js`.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ObservatoryPanel, PANEL_PATH } from "./pages/panel.js";
import { ObservatorySettings } from "./pages/settings.js";

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
});
