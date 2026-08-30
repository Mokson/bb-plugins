import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ThreadList } from "./src/ThreadList";
import { ChildThreadsChip } from "./src/header/ChildThreadsChip";

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "better-sidebar",
    title: "Better Sidebar",
    description:
      "Threads grouped by activity date, with provider logos, minimal status glyphs and a hover dossier.",
    component: ThreadList,
  });

  // B58.1. The header's own home for a thread's children, reachable when the
  // sidebar is collapsed or the phone drawer is closed.
  app.slots.experimental_threadHeaderAction({
    id: "children",
    title: "Child threads",
    component: ChildThreadsChip,
  });
});
