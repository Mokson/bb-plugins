/**
 * Pure path + tree helpers. No SDK imports so these stay unit-testable
 * without a bb server.
 */

export const MAX_TREE_ENTRIES = 8000;
export const PREVIEW_BYTE_LIMIT = 1024 * 1024;

export interface TreeEntry {
  path: string;
  kind: "file" | "directory";
}

/** Normalize an SDK path list into sorted relative entries. */
export function normalizeEntries(raw: unknown): TreeEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: TreeEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const path = item.replace(/\/+$/, "");
      if (path.length > 0) out.push({ path, kind: "file" });
      continue;
    }
    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const pathValue =
        typeof record["path"] === "string"
          ? (record["path"] as string).replace(/\/+$/, "")
          : typeof record["relativePath"] === "string"
            ? (record["relativePath"] as string).replace(/\/+$/, "")
            : null;
      if (pathValue === null || pathValue.length === 0) continue;
      const kindValue = record["kind"];
      out.push({
        path: pathValue,
        kind: kindValue === "directory" ? "directory" : "file",
      });
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export function truncateEntries(entries: TreeEntry[]): {
  entries: TreeEntry[];
  truncated: boolean;
} {
  if (entries.length <= MAX_TREE_ENTRIES) return { entries, truncated: false };
  return { entries: entries.slice(0, MAX_TREE_ENTRIES), truncated: true };
}

/** Case-insensitive substring filter over paths, capped for bounded output. */
export function filterPaths(entries: TreeEntry[], query: string, limit = 100): string[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    if (entry.path.toLowerCase().includes(needle)) {
      out.push(entry.path);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  children: TreeNode[];
}

interface MutableDir {
  name: string;
  path: string;
  dirs: Map<string, MutableDir>;
  files: Map<string, string>;
}

/**
 * Build a directory tree from flat entries. Collapses single-child directory
 * chains (t3code's flattenEmptyDirectories) so deep paths stay compact.
 */
export function buildTree(entries: TreeEntry[]): TreeNode[] {
  const root: MutableDir = { name: "", path: "", dirs: new Map(), files: new Map() };
  for (const entry of entries) {
    const segments = entry.path.split("/").filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    let level = root;
    let prefix = "";
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i] as string;
      prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;
      const last = i === segments.length - 1;
      if (last && entry.kind === "file") {
        if (!level.files.has(segment)) level.files.set(segment, prefix);
      } else {
        let dir = level.dirs.get(segment);
        if (!dir) {
          dir = { name: segment, path: prefix, dirs: new Map(), files: new Map() };
          level.dirs.set(segment, dir);
        }
        level = dir;
      }
    }
  }

  const convert = (dir: MutableDir): TreeNode[] => {
    const dirs = Array.from(dir.dirs.values())
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((d) => {
        const node: TreeNode = { name: d.name, path: d.path, kind: "directory", children: convert(d) };
        return collapseChain(node);
      });
    const files = Array.from(dir.files.entries())
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([name, path]): TreeNode => ({ name, path, kind: "file", children: [] }));
    return [...dirs, ...files];
  };
  return convert(root);
}

function collapseChain(node: TreeNode): TreeNode {
  let current = node;
  while (current.kind === "directory" && current.children.length === 1) {
    const only = current.children[0] as TreeNode;
    if (only.kind !== "directory") break;
    current = {
      name: `${current.name}/${only.name}`,
      path: only.path,
      kind: "directory",
      children: only.children,
    };
  }
  return { ...current, children: current.children.map(collapseChain) };
}

/** Join a workspace root and a validated relative path. */
export function joinRoot(root: string, rel: string): string {
  return root.endsWith("/") ? `${root}${rel}` : `${root}/${rel}`;
}

export type EntryGlyphKind =
  | "folder"
  | "folder-open"
  | "file"
  | "file-code"
  | "file-text"
  | "file-image";

const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "py", "go", "rs", "java", "rb", "php", "sh", "bash",
  "css", "scss", "less", "html", "vue", "svelte", "sql",
  "c", "h", "cpp", "hpp", "cs", "swift", "kt", "scala",
]);
const TEXT_DOC_EXTENSIONS = new Set([
  "md", "mdx", "markdown", "txt", "json", "yml", "yaml", "toml",
]);
const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico",
]);

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "";
  return path.slice(dot + 1).toLowerCase();
}

/** Which glyph a tree row draws. Pure for tests. */
export function glyphForEntry(
  kind: "file" | "directory",
  path: string,
  expanded: boolean,
): EntryGlyphKind {
  if (kind === "directory") return expanded ? "folder-open" : "folder";
  const extension = extensionOf(path);
  if (CODE_EXTENSIONS.has(extension)) return "file-code";
  if (TEXT_DOC_EXTENSIONS.has(extension)) return "file-text";
  if (IMAGE_EXTENSIONS.has(extension)) return "file-image";
  return "file";
}

export function isProbablyTextPath(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|json|md|mdx|txt|css|scss|html|yml|yaml|toml|py|go|rs|java|rb|sh|sql)$/i.test(
    path,
  );
}

export const EXPLORER_DEFAULT_WIDTH_PX = 280;
export const EXPLORER_MIN_WIDTH_PX = 180;
export const EXPLORER_MAX_WIDTH_PX = 620;
/** Width the preview keeps when the tree is dragged wide. */
export const MIN_PREVIEW_WIDTH_PX = 240;

/** Clamp an explorer width, reserving preview room. Pure for tests. */
export function clampExplorerWidth(widthPx: number, containerPx: number): number {
  if (!Number.isFinite(widthPx) || !Number.isFinite(containerPx) || containerPx <= 0) {
    return EXPLORER_DEFAULT_WIDTH_PX;
  }
  const available = Math.max(EXPLORER_MIN_WIDTH_PX, containerPx - MIN_PREVIEW_WIDTH_PX);
  const max = Math.min(EXPLORER_MAX_WIDTH_PX, available);
  return Math.min(max, Math.max(EXPLORER_MIN_WIDTH_PX, widthPx));
}
