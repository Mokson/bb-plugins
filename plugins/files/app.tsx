import { definePluginApp } from "@get-bb/plugin-sdk/app";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { FileContent, FilesPanel } from "./src/files/FilesPanel";

function WorkspaceFileOpener(props: PluginFileOpenerProps) {
  const source = props.source;
  // v1 supports workspace files routed through the owning thread. Every other
  // source (host absolute paths, thread-storage, snapshots) keeps BB's
  // built-in preview so we never guess an environment or host id.
  if (source.kind !== "workspace" || source.threadId === null) {
    return <props.Original />;
  }
  return <FileContent threadId={source.threadId} path={props.path} />;
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "files",
    title: "Files",
    component: FilesPanel,
    layout: "flush",
    run: ({ openPanel }) => {
      openPanel({ title: "Files" });
    },
  });

  app.slots.fileOpener({
    id: "files-viewer",
    title: "Files viewer",
    extensions: ["ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "md", "mdx", "txt", "css", "yml", "yaml", "toml"],
    component: WorkspaceFileOpener,
  });
});
