// Invariant: the parent walk always terminates. Cost rolls up by root, so a
// cycle or a pathological chain must cost a wrong root, never a hung ingest.
import { describe, expect, it } from "vitest";
import { ThreadRegistry } from "../src/core/threads.js";
import { makeIngestHost } from "./fakes.js";

describe("root and depth", () => {
  it("resolves a real chain to its root", async () => {
    const host = makeIngestHost();
    host.threads.set("root", { id: "root", parentThreadId: null });
    host.threads.set("mid", { id: "mid", parentThreadId: "root" });
    host.threads.set("leaf", { id: "leaf", parentThreadId: "mid" });
    const registry = new ThreadRegistry({
      threads: host.bb.sdk.threads,
      runFolder: () => null,
    });

    expect(await registry.lineageOf("leaf")).toMatchObject({
      root: "root",
      depth: 2,
      parent: "mid",
    });
  });

  it("stops on a cycle instead of walking forever", async () => {
    const host = makeIngestHost();
    host.threads.set("a", { id: "a", parentThreadId: "b" });
    host.threads.set("b", { id: "b", parentThreadId: "a" });
    const registry = new ThreadRegistry({
      threads: host.bb.sdk.threads,
      runFolder: () => null,
    });

    const lineage = await registry.lineageOf("a");
    expect(lineage.depth).toBeLessThanOrEqual(2);
    expect(["a", "b"]).toContain(lineage.root);
  });

  it("stops at the depth cap on a chain longer than it", async () => {
    const host = makeIngestHost();
    for (let index = 0; index < 20; index += 1) {
      host.threads.set(`t${index}`, {
        id: `t${index}`,
        parentThreadId: index === 19 ? null : `t${index + 1}`,
      });
    }
    const registry = new ThreadRegistry({
      threads: host.bb.sdk.threads,
      runFolder: () => null,
      depthCap: 3,
    });

    expect((await registry.lineageOf("t0")).depth).toBeLessThanOrEqual(3);
  });
});
