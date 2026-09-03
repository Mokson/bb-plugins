import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_SourceCode as SourceCode,
  Markdown,
  useComposer,
  useRpc,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { filesRpcContract } from "../files-contract";
import { buildTree, clampExplorerWidth, EXPLORER_DEFAULT_WIDTH_PX, EXPLORER_MAX_WIDTH_PX, EXPLORER_MIN_WIDTH_PX, glyphForEntry, isProbablyTextPath, type EntryGlyphKind, type TreeEntry, type TreeNode } from "../paths";

const EXPLORER_WIDTH_STORAGE_KEY = "files.explorerWidth";

function selectedKey(threadId: string): string {
  return `files.selected:${threadId}`;
}

const IMAGE_PATH_PATTERN = /\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;

function paramsPath(params: PluginThreadPanelProps["params"]): string | null {
  if (params !== null && typeof params === "object" && !Array.isArray(params)) {
    const path = (params as Record<string, unknown>)["path"];
    if (typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("..")) {
      return path;
    }
  }
  return null;
}

function mentionFor(path: string): string {
  return `@${path}`;
}

/** File-tree glyph: spine with branches, drawn in currentColor. */
function FileTreeIcon({ dimmed }: { dimmed: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`size-3.5${dimmed ? " opacity-50" : ""}`}
    >
      <path d="M7 3v18" />
      <path d="M7 7h6" />
      <path d="M7 12h10" />
      <path d="M7 17h6" />
      <circle cx="16" cy="7" r="1.4" />
      <circle cx="20" cy="12" r="1.4" />
      <circle cx="16" cy="17" r="1.4" />
    </svg>
  );
}
/** Drag payload so rows can be dropped into the chat composer as a mention.
 * Attached both to the row container (gaps buy you the row) and to the label
 * button itself: initiating a native drag from inside a nested button is
 * browser-dependent, so the grab point must be its own drag source. */
function beginFileDrag(event: React.DragEvent, path: string) {
  event.stopPropagation();
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("text/plain", `${mentionFor(path)} `);
  event.dataTransfer.setData("application/x-bb-file-path", path);
}

export function FilesPanel(props: PluginThreadPanelProps) {
  const { threadId, params } = props;
  const rpc = useRpc<typeof filesRpcContract>();
  const composer = useComposer();
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(() => {
    const fromParams = paramsPath(params);
    if (fromParams !== null) return fromParams;
    try {
      return localStorage.getItem(selectedKey(threadId));
    } catch {
      return null;
    }
  });
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [explorerWidth, setExplorerWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(EXPLORER_WIDTH_STORAGE_KEY);
      const parsed = raw === null ? NaN : Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : EXPLORER_DEFAULT_WIDTH_PX;
    } catch {
      return EXPLORER_DEFAULT_WIDTH_PX;
    }
  });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const tree = await rpc.call("tree", { threadId });
      setEntries(tree.entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to list files.");
      setEntries(null);
    } finally {
      setLoading(false);
    }
  }, [rpc, threadId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!entries) return null;
    if (needle.length === 0) return entries;
    return entries.filter((e) => e.path.toLowerCase().includes(needle));
  }, [entries, needle]);

  const tree = useMemo<TreeNode[]>(() => (filtered ? buildTree(filtered) : []), [filtered]);

  const openFile = useCallback(
    (path: string) => {
      setSelected(path);
      try {
        localStorage.setItem(selectedKey(threadId), path);
      } catch {
        // Private-mode storage failures keep an in-memory selection only.
      }
    },
    [threadId],
  );

  const closeFile = useCallback(() => {
    setSelected(null);
    try {
      localStorage.removeItem(selectedKey(threadId));
    } catch {
      // Ignore storage failures; the in-memory close still applies.
    }
  }, [threadId]);

  const persistWidth = useCallback((widthPx: number) => {
    setExplorerWidth(widthPx);
    try {
      localStorage.setItem(EXPLORER_WIDTH_STORAGE_KEY, String(Math.round(widthPx)));
    } catch {
      // Private-mode storage failures keep an in-memory width only.
    }
  }, []);

  const applyWidth = useCallback(
    (widthPx: number) => {
      const containerPx = containerRef.current?.clientWidth ?? 0;
      persistWidth(clampExplorerWidth(widthPx, containerPx));
    },
    [persistWidth],
  );

  const nudgeWidth = useCallback(
    (deltaPx: number) => {
      const containerPx = containerRef.current?.clientWidth ?? 0;
      const base =
        containerPx > 0 ? clampExplorerWidth(explorerWidth, containerPx) : explorerWidth;
      persistWidth(clampExplorerWidth(base + deltaPx, containerPx));
    },
    [explorerWidth, persistWidth],
  );

  const resetWidth = useCallback(() => {
    setExplorerWidth(EXPLORER_DEFAULT_WIDTH_PX);
    try {
      localStorage.removeItem(EXPLORER_WIDTH_STORAGE_KEY);
    } catch {
      // Ignore storage failures; the in-memory default still applies.
    }
  }, []);

  const copyMention = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(mentionFor(path));
      toast.success("Mention copied");
    } catch {
      toast.error("Failed to copy mention");
    }
  }, []);

  const addToChat = useCallback(
    (path: string) => {
      composer.updateText((current) =>
        current.length === 0 ? `${mentionFor(path)} ` : `${current} ${mentionFor(path)} `,
      );
      toast.success("Added to chat");
    },
    [composer],
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-background">
      <div className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <button
          type="button"
          aria-label="Refresh files"
          className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => void refresh()}
        >
          Refresh
        </button>
        <input
          type="search"
          aria-label="Search files"
          placeholder="Search files"
          value={query}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setQuery("");
          }}
          className="h-7 min-w-0 flex-1 rounded border border-border/60 bg-background px-2 text-xs"
        />
        {needle.length > 0 && filtered ? (
          <span className="shrink-0 px-1 text-[11px] tabular-nums text-muted-foreground">
            {filtered.filter((e) => e.kind === "file").length} of{" "}
            {entries?.filter((e) => e.kind === "file").length ?? 0}
          </span>
        ) : null}
        <button
          type="button"
          aria-pressed={explorerOpen}
          aria-label={explorerOpen ? "Hide the file list" : "Show the file list"}
          title={explorerOpen ? "Hide the file list" : "Show the file list"}
          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => setExplorerOpen((v) => !v)}
        >
          <FileTreeIcon dimmed={!explorerOpen} />
        </button>
      </div>
      <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selected ? (
            <FileContent
              key={selected}
              threadId={threadId}
              path={selected}
              onClose={closeFile}
            />
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted-foreground">
              Select a file to preview it. Drag a file or folder into chat to reference it.
            </div>
          )}
        </div>
        {explorerOpen ? (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the file list"
              aria-valuenow={Math.round(explorerWidth)}
              aria-valuemin={EXPLORER_MIN_WIDTH_PX}
              aria-valuemax={EXPLORER_MAX_WIDTH_PX}
              tabIndex={0}
              className={`w-1 shrink-0 cursor-col-resize touch-none transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none${isDragging ? " bg-accent" : ""}`}
              onPointerDown={(event) => {
                dragStateRef.current = { startX: event.clientX, startWidth: explorerWidth };
                event.currentTarget.setPointerCapture?.(event.pointerId);
                setIsDragging(true);
              }}
              onPointerMove={(event) => {
                const drag = dragStateRef.current;
                if (!drag) return;
                // Divider sits left of the tree: dragging left grows it.
                applyWidth(drag.startWidth + (drag.startX - event.clientX));
              }}
              onPointerUp={() => {
                dragStateRef.current = null;
                setIsDragging(false);
              }}
              onPointerCancel={() => {
                dragStateRef.current = null;
                setIsDragging(false);
              }}
              onDoubleClick={resetWidth}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft") {
                  event.preventDefault();
                  nudgeWidth(16);
                } else if (event.key === "ArrowRight") {
                  event.preventDefault();
                  nudgeWidth(-16);
                }
              }}
            />
            <aside
              className="flex min-h-0 shrink-0 flex-col border-l border-border/60"
              style={{ width: explorerWidth }}
            >
            <div
              className="min-h-0 flex-1 overflow-auto p-1.5"
              aria-label="Workspace files"
              title="Drag a file or folder into chat to reference it"
            >
              {loading ? (
                <p className="px-2 py-4 text-xs text-muted-foreground">Loading files…</p>
              ) : error ? (
                <p className="px-2 py-4 text-xs text-destructive">{error}</p>
              ) : tree.length === 0 ? (
                <p className="px-2 py-4 text-xs text-muted-foreground">No files match.</p>
              ) : (
                tree.map((node) => (
                  <TreeRow
                    key={node.path}
                    node={node}
                    depth={0}
                    selected={selected}
                    onOpen={openFile}
                    onCopy={copyMention}
                    onAddToChat={addToChat}
                  />
                ))
              )}
            </div>
          </aside>
          </>
        ) : null}
      </div>
    </div>
  );
}

function RowGlyph({ kind }: { kind: EntryGlyphKind }) {
  const common = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    className: "size-3.5 shrink-0 opacity-70",
  } as const;
  switch (kind) {
    case "folder":
      return (
        <svg {...common}>
          <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
        </svg>
      );
    case "folder-open":
      return (
        <svg {...common}>
          <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
        </svg>
      );
    case "file-code":
      return (
        <svg {...common}>
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
          <path d="m10 13-2 2 2 2" />
          <path d="m14 13 2 2-2 2" />
        </svg>
      );
    case "file-text":
      return (
        <svg {...common}>
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
          <path d="M10 9H8" />
          <path d="M16 13H8" />
          <path d="M16 17H8" />
        </svg>
      );
    case "file-image":
      return (
        <svg {...common}>
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
          <circle cx="12" cy="12" r="1.5" />
          <path d="m20 17-4.5-4.5L8 20" />
        </svg>
      );
    case "file":
    default:
      return (
        <svg {...common}>
          <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
        </svg>
      );
  }
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-3.5 shrink-0 opacity-70"
    >
      {open ? <path d="m6 9 6 6 6-6" /> : <path d="m9 18 6-6-6-6" />}
    </svg>
  );
}

function TreeRow(props: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onOpen: (path: string) => void;
  onCopy: (path: string) => void;
  onAddToChat: (path: string) => void;
}) {
  const { node, depth, selected } = props;
  const [expanded, setExpanded] = useState(depth < 1);
  const isDir = node.kind === "directory";
  const active = !isDir && selected === node.path;
  const glyph = glyphForEntry(node.kind, node.path, expanded);

  return (
    <div>
      <div
        draggable
        onDragStart={(event) => beginFileDrag(event, node.path)}
        title={isDir ? `Drag into chat to reference ${node.path}` : node.path}
        className={`group flex w-full select-none items-center gap-1.5 rounded-sm py-1 pr-2 text-left text-xs leading-tight ${
          active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        }`}
        style={{ paddingLeft: `${6 + depth * 18}px` }}
      >
        {isDir ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? "Collapse" : "Expand"} ${node.path}`}
            className="shrink-0 rounded"
            onClick={() => setExpanded((v) => !v)}
          >
            <Chevron open={expanded} />
          </button>
        ) : (
          <span className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        <RowGlyph kind={glyph} />
        <button
          type="button"
          draggable
          onDragStart={(event) => beginFileDrag(event, node.path)}
          className="min-w-0 flex-1 cursor-grab truncate text-left font-mono text-[11px]"
          title={node.path}
          onClick={() => (isDir ? setExpanded((v) => !v) : props.onOpen(node.path))}
        >
          {node.name}
        </button>
        <span className="hidden shrink-0 gap-1 group-hover:inline-flex">
          {!isDir ? (
            <button
              type="button"
              aria-label={`Copy mention for ${node.path}`}
              className="rounded px-1 hover:bg-background"
              onClick={() => void props.onCopy(node.path)}
            >
              @
            </button>
          ) : null}
          <button
            type="button"
            aria-label={`Add ${node.path} to chat`}
            className="rounded px-1 hover:bg-background"
            onClick={() => props.onAddToChat(node.path)}
          >
            +
          </button>
        </span>
      </div>
      {isDir && expanded ? (
        <div>
          {node.children.map((child) => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              onOpen={props.onOpen}
              onCopy={props.onCopy}
              onAddToChat={props.onAddToChat}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ImageContent(props: { threadId: string; path: string }) {
  const { threadId, path } = props;
  const rpc = useRpc<typeof filesRpcContract>();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "unavailable" }
    | { status: "ready"; src: string }
  >({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    rpc
      .call("media", { threadId, path })
      .then((result) => {
        if (cancelled) return;
        if (!result.available || !result.imageUrl) {
          setState({ status: "unavailable" });
          return;
        }
        setState({ status: "ready", src: result.imageUrl });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: "error", message: err instanceof Error ? err.message : "Failed to load image." });
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, path]);

  if (state.status === "loading") {
    return <p className="px-4 py-6 text-xs text-muted-foreground">Loading {path}…</p>;
  }
  if (state.status === "error") {
    return <p className="px-4 py-6 text-xs text-destructive">{state.message}</p>;
  }
  if (state.status === "unavailable") {
    return <p className="px-4 py-6 text-xs text-muted-foreground">Image preview is unavailable for this file.</p>;
  }
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <img className="max-h-full max-w-full object-contain" src={state.src} alt={path} />
    </div>
  );
}

export function FileContent(props: { threadId: string; path: string; onClose?: () => void }) {
  const { threadId, path } = props;
  const rpc = useRpc<typeof filesRpcContract>();
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | {
        status: "ready";
        content: string;
        sha256: string | null;
        truncated: boolean;
        dirty: boolean;
        saving: boolean;
        conflict: boolean;
      }
  >({ status: "loading" });

  const isImage = IMAGE_PATH_PATTERN.test(path);
  const isMarkdown = /\.mdx?$/i.test(path);
  // Declared with the other hooks: this component returns early for images
  // and pending reads, so anything below those returns would break hook order.
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {    if (isImage) return;
    let cancelled = false;
    setState({ status: "loading" });
    rpc
      .call("read", { threadId, path })
      .then((result) => {
        if (cancelled) return;
        setState({
          status: "ready",
          content: result.content,
          sha256: result.sha256,
          truncated: result.truncated,
          dirty: false,
          saving: false,
          conflict: false,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: "error", message: err instanceof Error ? err.message : "Failed to read file." });
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, path, isImage]);

  const save = useCallback(
    async (next: string, expectedSha256: string | null) => {
      setState((prev) => (prev.status === "ready" ? { ...prev, saving: true } : prev));
      try {
        const result = await rpc.call("save", {
          threadId,
          path,
          content: next,
          ...(expectedSha256 === null ? { expectedSha256: null } : { expectedSha256 }),
        });
        if (result.outcome === "conflict") {
          setState((prev) =>
            prev.status === "ready" ? { ...prev, saving: false, conflict: true } : prev,
          );
          toast.error("File changed on disk. Re-read before overwriting.");
        } else {
          setState((prev) =>
            prev.status === "ready"
              ? { ...prev, saving: false, dirty: false, conflict: false, sha256: result.sha256 }
              : prev,
          );
          toast.success("Saved");
        }
      } catch (err) {
        setState((prev) => (prev.status === "ready" ? { ...prev, saving: false } : prev));
        toast.error(err instanceof Error ? err.message : "Save failed.");
      }
    },
    [rpc, threadId, path],
  );

  if (isImage) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <FileHeader
          path={path}
          dirty={false}
          conflict={false}
          editable={false}
          saving={false}
          onSave={() => undefined}
          onClose={props.onClose}
        />
        <ImageContent threadId={threadId} path={path} />
      </div>
    );
  }

  if (state.status === "loading") {
    return <p className="px-4 py-6 text-xs text-muted-foreground">Loading {path}…</p>;
  }
  if (state.status === "error") {
    return <p className="px-4 py-6 text-xs text-destructive">{state.message}</p>;
  }

  const rendered = isMarkdown && !showSource;
  const editable = !rendered && isProbablyTextPath(path) && !state.truncated;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FileHeader
        path={path}
        dirty={state.dirty}
        conflict={state.conflict}
        editable={editable}
        saving={state.saving}
        onSave={() => void save(state.content, state.sha256)}
        onClose={props.onClose}
        renderedToggle={
          isMarkdown
            ? {
                rendered,
                onToggle: () => setShowSource((v) => !v),
              }
            : undefined
        }
      />
      {state.truncated ? (
        <div className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-[11px] text-warning-foreground">
          Preview limited to the first 1 MB of this file.
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {rendered ? (
          <Markdown content={state.content} />
        ) : editable ? (
          <textarea
            aria-label={`Edit ${path}`}
            value={state.content}
            spellCheck={false}
            onChange={(event) =>
              setState((prev) =>
                prev.status === "ready" ? { ...prev, content: event.target.value, dirty: true } : prev,
              )
            }
            className="min-h-full w-full flex-1 resize-none rounded border border-border/60 bg-background p-2 font-mono text-[11px] leading-relaxed"
            rows={30}
          />
        ) : (
          <SourceCode content={state.content} path={path} />
        )}
        {!editable && !isMarkdown && !isProbablyTextPath(path) ? (
          <p className="mt-2 text-[11px] text-muted-foreground">
            Binary preview is not supported in this version.
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Eye / code glyph for the rendered-markdown toggle, drawn in currentColor. */
function RenderedToggleIcon({ rendered }: { rendered: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-3.5"
    >
      {rendered ? (
        <>
          <path d="m16 18 6-6-6-6" />
          <path d="m8 6-6 6 6 6" />
        </>
      ) : (
        <>
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

function FileHeader(props: {
  path: string;
  dirty: boolean;
  conflict: boolean;
  editable: boolean;
  saving: boolean;
  onSave: () => void;
  onClose?: () => void;
  renderedToggle?: { rendered: boolean; onToggle: () => void };
}) {
  const toggle = props.renderedToggle;
  return (
    <div className="flex h-9 min-h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={props.path}>
        {props.path}
      </span>
      {props.dirty ? <span className="text-[11px] text-muted-foreground">● unsaved</span> : null}
      {props.conflict ? <span className="text-[11px] text-destructive">conflict</span> : null}
      {toggle ? (
        <button
          type="button"
          aria-pressed={toggle.rendered}
          aria-label={toggle.rendered ? "Show markdown source" : "Show rendered markdown"}
          title={toggle.rendered ? "Show markdown source" : "Show rendered markdown"}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={toggle.onToggle}
        >
          <RenderedToggleIcon rendered={toggle.rendered} />
        </button>
      ) : null}
      {props.editable ? (
        <button
          type="button"
          disabled={!props.dirty || props.saving}
          className="rounded border border-border/70 px-2 py-0.5 text-[11px] disabled:opacity-50"
          onClick={props.onSave}
        >
          {props.saving ? "Saving…" : "Save"}
        </button>
      ) : null}
      {props.onClose ? (
        <button
          type="button"
          aria-label="Close file"
          className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={props.onClose}
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}
