import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SkillUsagePanel } from "./src/panel/SkillUsagePanel";

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "skill-usage",
    title: "Skills Usage",
    // BB draws skill loads with the Zap glyph, so the tab matches what the
    // transcript already shows. Only used when the plugin ships no logo.
    icon: "Zap",
    component: SkillUsagePanel,
    layout: "padded",
    run: ({ openPanel }) => {
      openPanel({ title: "Skills Usage" });
    },
  });
});
