import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SkillUsagePanel } from "./src/panel/SkillUsagePanel";

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "skill-usage",
    title: "Skills",
    component: SkillUsagePanel,
    layout: "padded",
    run: ({ openPanel }) => {
      openPanel({ title: "Skills" });
    },
  });
});
