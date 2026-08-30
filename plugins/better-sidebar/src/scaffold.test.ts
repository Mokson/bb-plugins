import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

describe("scaffold", () => {
  it("loads the backend factory and logs its plugin id", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "better-sidebar",
    });

    await plugin(bb);

    expect(harness.logEntries.some((entry) => entry.message.includes("better-sidebar"))).toBe(
      true,
    );
  });
});
