// Module toggles live in settings and need a plugin reload; the kv override
// does not. The override therefore has to WIN, or the panel could not stop a
// misbehaving module until the next reload.
import { describe, expect, it } from "vitest";
import { moduleEnabledKvKey } from "../src/module.js";
import { buildStatus } from "../src/server.js";
import { makeHarness } from "./fakes.js";

describe("the module enabled check", () => {
  it("prefers the kv override over the setting, in both directions", async () => {
    const settingValues = {
      "modules_spend_enabled": true,
      "modules_watch_enabled": false,
    };
    const harness = makeHarness(settingValues);
    const spend = harness.registry.context("spend");
    const watch = harness.registry.context("watch");

    expect(await spend.enabled()).toBe(true);
    expect(await watch.enabled()).toBe(false);

    await harness.bb.storage.kv.set(moduleEnabledKvKey("spend"), false);
    await harness.bb.storage.kv.set(moduleEnabledKvKey("watch"), true);

    expect(await spend.enabled()).toBe(false);
    expect(await watch.enabled()).toBe(true);
  });

  it("falls back to the setting once the override is deleted", async () => {
    const harness = makeHarness({ "modules_audit_enabled": true });
    const audit = harness.registry.context("audit");
    await harness.bb.storage.kv.set(moduleEnabledKvKey("audit"), false);
    expect(await audit.enabled()).toBe(false);

    await harness.bb.storage.kv.delete(moduleEnabledKvKey("audit"));

    expect(await audit.enabled()).toBe(true);
  });

  it("names the deciding layer in the status view", async () => {
    const harness = makeHarness({ "modules_eval_enabled": true });
    await harness.bb.storage.kv.set(moduleEnabledKvKey("eval"), false);

    const status = await buildStatus({
      bb: harness.bb,
      store: harness.store,
      registry: harness.registry,
      settings: harness.settings,
      now: () => "2026-09-01T00:00:00.000Z",
    });

    const evalModule = status.modules.find((module) => module.id === "eval")!;
    expect(evalModule.source).toBe("kv");
    expect(evalModule.enabled).toBe(false);
    const spend = status.modules.find((module) => module.id === "spend")!;
    expect(spend.source).toBe("default");
  });
});
