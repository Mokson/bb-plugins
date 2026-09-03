import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { filesRpcContract } from "./files-contract";
import { filterPaths, joinRoot, normalizeEntries, PREVIEW_BYTE_LIMIT, truncateEntries } from "./paths";

interface Workspace {
  environmentId: string;
  hostId: string | undefined;
  root: string;
}

/** Resolve the thread's workspace. Never invent ids: everything comes from the thread. */
async function resolveWorkspace(
  sdk: BbPluginApi["sdk"],
  threadId: string,
): Promise<Workspace> {
  // Plain threads.get returns ThreadResponse, which carries only
  // environmentId — the full environment object needs environments.get.
  const thread = (await sdk.threads.get({ threadId })) as unknown as Record<string, unknown>;
  const environmentId =
    typeof thread["environmentId"] === "string" ? thread["environmentId"] : null;
  if (environmentId === null) {
    throw new Error("Thread has no workspace environment yet.");
  }
  const environment = (await sdk.environments.get({
    environmentId,
  })) as unknown as Record<string, unknown>;
  const root = typeof environment["path"] === "string" ? environment["path"] : null;
  if (root === null || root.length === 0) {
    throw new Error("Thread environment has no workspace path yet.");
  }
  const hostId = typeof environment["hostId"] === "string" ? environment["hostId"] : undefined;
  return { environmentId, hostId, root };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function toFiniteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "bmp",
  "ico",
]);

function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export default async function plugin(bb: BbPluginApi) {
  // Preview URLs are per (host, root) and expire, so they are cached only for
  // as long as they are valid.
  const previewCache = new Map<string, { baseUrl: string; expiresAtMs: number }>();

  async function previewBaseUrl(hostId: string | undefined, root: string): Promise<string> {
    const key = `${hostId ?? "primary"}:${root}`;
    const cached = previewCache.get(key);
    if (cached && cached.expiresAtMs - Date.now() > 30_000) return cached.baseUrl;
    const preview = await bb.sdk.files.createPreview({
      ...(hostId !== undefined ? { hostId } : {}),
      rootPath: root,
    });
    previewCache.set(key, { baseUrl: preview.baseUrl, expiresAtMs: preview.expiresAtMs });
    return preview.baseUrl;
  }

  bb.onDispose(() => {
    previewCache.clear();
  });

  bb.rpc.register(filesRpcContract, {
    tree: async ({ threadId }) => {
      const workspace = await resolveWorkspace(bb.sdk, threadId);
      const result = (await bb.sdk.files.listPaths({
        ...(workspace.hostId !== undefined ? { hostId: workspace.hostId } : {}),
        path: workspace.root,
        includeFiles: true,
        includeDirectories: true,
      })) as unknown;
      // The host returns either `{ paths: [...] }` or a bare array; accept both.
      const record = asRecord(result);
      const raw = Array.isArray(result) ? result : (record["paths"] ?? record["entries"] ?? []);
      const normalized = normalizeEntries(raw);
      const { entries, truncated } = truncateEntries(normalized);
      return { root: workspace.root, entries, truncated };
    },

    read: async ({ threadId, path }) => {
      const workspace = await resolveWorkspace(bb.sdk, threadId);
      const absolute = joinRoot(workspace.root, path);
      const file = asRecord(
        await bb.sdk.files.read({
          ...(workspace.hostId !== undefined ? { hostId: workspace.hostId } : {}),
          path: absolute,
          rootPath: workspace.root,
        }),
      );
      const encoding = typeof file["contentEncoding"] === "string" ? file["contentEncoding"] : "utf8";
      if (encoding !== "utf8") {
        throw new Error(`Preview does not support ${encoding} content.`);
      }
      const content = typeof file["content"] === "string" ? file["content"] : "";
      const sizeBytes = toFiniteNonNegative(file["sizeBytes"] ?? file["byteLength"]);
      const sha256 = typeof file["sha256"] === "string" ? file["sha256"] : null;
      const truncated =
        typeof sizeBytes === "number"
          ? sizeBytes > PREVIEW_BYTE_LIMIT
          : content.length > PREVIEW_BYTE_LIMIT;
      return {
        path,
        content: content.slice(0, PREVIEW_BYTE_LIMIT),
        sha256,
        sizeBytes,
        truncated,
      };
    },

    save: async ({ threadId, path, content, expectedSha256 }) => {
      const workspace = await resolveWorkspace(bb.sdk, threadId);
      const absolute = joinRoot(workspace.root, path);
      const saved = asRecord(
        await bb.sdk.files.write({
          ...(workspace.hostId !== undefined ? { hostId: workspace.hostId } : {}),
          path: absolute,
          rootPath: workspace.root,
          content,
          ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
        }),
      );
      const outcome: "conflict" | "written" = saved["outcome"] === "conflict" ? "conflict" : "written";
      return {
        outcome,
        sha256: typeof saved["sha256"] === "string" ? saved["sha256"] : null,
        currentSha256:
          typeof saved["currentSha256"] === "string" ? saved["currentSha256"] : null,
      };
    },

    search: async ({ threadId, query }) => {
      const workspace = await resolveWorkspace(bb.sdk, threadId);
      // Server-side fuzzy listing keeps large workspaces bounded; the output
      // schema caps the array implicitly by construction (100).
      const result = (await bb.sdk.files.list({
        ...(workspace.hostId !== undefined ? { hostId: workspace.hostId } : {}),
        path: workspace.root,
        query,
        limit: 100,
      })) as unknown;
      const record = asRecord(result);
      const raw = Array.isArray(result) ? result : (record["paths"] ?? record["entries"] ?? record["files"] ?? []);
      const normalized = normalizeEntries(raw);
      const fromServer = filterPaths(normalized, query);
      if (fromServer.length > 0) return { paths: fromServer };
      // Fallback: full listing filtered locally (small workspaces).
      const full = (await bb.sdk.files.listPaths({
        ...(workspace.hostId !== undefined ? { hostId: workspace.hostId } : {}),
        path: workspace.root,
        includeFiles: true,
        includeDirectories: false,
      })) as unknown;
      const fullRecord = asRecord(full);
      const fullRaw = Array.isArray(full) ? full : (fullRecord["paths"] ?? fullRecord["entries"] ?? []);
      void asStringArray;
      return { paths: filterPaths(normalizeEntries(fullRaw), query) };
    },

    changed: async ({ threadId }) => {
      const workspace = await resolveWorkspace(bb.sdk, threadId);
      let result: unknown;
      try {
        result = await bb.sdk.environments.diffFiles({
          environmentId: workspace.environmentId,
          target: "uncommitted",
        });
      } catch {
        return { files: [], unavailable: true };
      }
      const record = asRecord(result);
      const raw = Array.isArray(result) ? result : (record["files"] ?? []);
      if (!Array.isArray(raw)) return { files: [], unavailable: true };
      const files: Array<{ path: string; additions: number; deletions: number }> = [];
      for (const item of raw) {
        const entry = asRecord(item);
        const path = typeof entry["path"] === "string" ? entry["path"] : null;
        if (path === null) continue;
        files.push({
          path,
          additions: toFiniteNonNegative(entry["additions"]) ?? 0,
          deletions: toFiniteNonNegative(entry["deletions"]) ?? 0,
        });
        if (files.length >= 200) break;
      }
      return { files, unavailable: false };
    },

    media: async ({ threadId, path }) => {
      // Images ride the confined preview transport as real URLs instead of
      // base64 through RPC: no size cap, no 8 MiB host-RPC limit pressure.
      if (!isImagePath(path)) {
        return { available: false, imageUrl: null, sizeBytes: null };
      }
      const workspace = await resolveWorkspace(bb.sdk, threadId);
      const baseUrl = await previewBaseUrl(workspace.hostId, workspace.root);
      const url = `${baseUrl.replace(/\/$/, "")}/${path
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")}`;
      return { available: true, imageUrl: url, sizeBytes: null };
    },
  });
}
