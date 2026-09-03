import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

function hostWith(overrides: {
  thread?: Record<string, unknown>;
  environment?: Record<string, unknown> | null;
  paths?: unknown;
  read?: Record<string, unknown>;
  write?: Record<string, unknown>;
  list?: unknown;
  diffFiles?: unknown;
  preview?: Record<string, unknown>;
}) {
  const thread = overrides.thread ?? { id: "t1", environmentId: "env1" };
  const environment =
    overrides.environment === undefined
      ? { id: "env1", hostId: "host1", path: "/root" }
      : overrides.environment;
  return createFakePluginHost({
    pluginId: "files",
    sdk: {
      threads: {
        get: async () => thread,
      },
      environments: {
        get: async () => {
          if (environment === null) throw new Error("no environment");
          return environment;
        },
        diffFiles: async () => {
          if (overrides.diffFiles !== undefined) return overrides.diffFiles;
          return { files: [] };
        },
      },
      files: {
        listPaths: async () => overrides.paths ?? { paths: [] },
        read: async () =>
          overrides.read ?? { content: "hello", contentEncoding: "utf8", sha256: "abc", sizeBytes: 5 },
        write: async () => overrides.write ?? { outcome: "written", sha256: "def" },
        list: async () => overrides.list ?? { paths: [] },
        createPreview: async () =>
          overrides.preview ?? { baseUrl: "https://preview.test/p", expiresAtMs: Date.now() + 60000 },
      },
    },
  });
}

describe("files rpc", () => {
  it("tree normalizes host paths", async () => {
    const host = hostWith({ paths: { paths: ["b.ts", "a.ts"] } });
    await plugin(host.bb);
    const tree = (await host.harness.behavior.callRpc("tree", { threadId: "t1" })) as {
      entries: Array<{ path: string }>;
      truncated: boolean;
      root: string;
    };
    expect(tree.root).toBe("/root");
    expect(tree.entries.map((e) => e.path)).toEqual(["a.ts", "b.ts"]);
    expect(tree.truncated).toBe(false);
  });

  it("tree rejects threads without a workspace", async () => {
    const host = hostWith({ thread: { id: "t1", environmentId: null } });
    await plugin(host.bb);
    await expect(host.harness.behavior.callRpc("tree", { threadId: "t1" })).rejects.toThrow();
  });

  it("tree rejects environments without a workspace path", async () => {
    const host = hostWith({ environment: { id: "env1", hostId: "host1", path: null } });
    await plugin(host.bb);
    await expect(host.harness.behavior.callRpc("tree", { threadId: "t1" })).rejects.toThrow();
  });

  it("read truncates at 1 MB", async () => {
    const host = hostWith({
      read: { content: "x".repeat(100), contentEncoding: "utf8", sha256: "abc", sizeBytes: 2 * 1024 * 1024 },
    });
    await plugin(host.bb);
    const file = (await host.harness.behavior.callRpc("read", { threadId: "t1", path: "big.ts" })) as {
      truncated: boolean;
    };
    expect(file.truncated).toBe(true);
  });

  it("save passes the CAS guard through", async () => {
    const host = hostWith({ write: { outcome: "conflict", currentSha256: "other" } });
    await plugin(host.bb);
    const result = (await host.harness.behavior.callRpc("save", {
      threadId: "t1",
      path: "a.ts",
      content: "next",
      expectedSha256: "abc",
    })) as { outcome: string };
    expect(result.outcome).toBe("conflict");
  });

  it("changed degrades to unavailable when diff fails", async () => {
    const host = createFakePluginHost({
      pluginId: "files",
      sdk: {
        threads: { get: async () => ({ id: "t1", environmentId: "env1" }) },
        files: { listPaths: async () => ({ paths: [] }) },
        environments: {
          get: async () => ({ id: "env1", hostId: "host1", path: "/root" }),
          diffFiles: async () => {
            throw new Error("no git");
          },
        },
      },
    });
    await plugin(host.bb);
    const result = (await host.harness.behavior.callRpc("changed", { threadId: "t1" })) as {
      unavailable: boolean;
    };
    expect(result.unavailable).toBe(true);
  });

  it("media returns a confined preview URL for images", async () => {
    const host = hostWith({});
    await plugin(host.bb);
    const result = (await host.harness.behavior.callRpc("media", {
      threadId: "t1",
      path: "assets/logo.png",
    })) as { available: boolean; imageUrl: string | null };
    expect(result.available).toBe(true);
    expect(result.imageUrl).toBe("https://preview.test/p/assets/logo.png");
  });

  it("media encodes path segments in the preview URL", async () => {
    const host = hostWith({});
    await plugin(host.bb);
    const result = (await host.harness.behavior.callRpc("media", {
      threadId: "t1",
      path: "my dir/logo.png",
    })) as { imageUrl: string | null };
    expect(result.imageUrl).toBe("https://preview.test/p/my%20dir/logo.png");
  });

  it("media is unavailable for non-image paths", async () => {
    const host = hostWith({});
    await plugin(host.bb);
    const result = (await host.harness.behavior.callRpc("media", {
      threadId: "t1",
      path: "a.ts",
    })) as { available: boolean };
    expect(result.available).toBe(false);
  });

  it("rejects traversal paths at the boundary", async () => {
    const host = hostWith({});
    await plugin(host.bb);
    await expect(
      host.harness.behavior.callRpc("read", { threadId: "t1", path: "../secret" }),
    ).rejects.toThrow();
  });
});
