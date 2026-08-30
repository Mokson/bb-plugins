import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ThreadList } from "./src/ThreadList";

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "better-sidebar",
    title: "Better Sidebar",
    description:
      "Threads grouped by activity date, with provider logos, minimal status glyphs and a hover dossier.",
    component: ThreadList,
  });
});
