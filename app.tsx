import { definePluginApp } from "@get-bb/plugin-sdk/app";

function BetterSidebarPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      Better Sidebar — scaffold
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "better-sidebar",
    title: "Better Sidebar",
    description: "A replacement sidebar thread list.",
    component: BetterSidebarPlaceholder,
  });
});
