// The blast radius invariant: a module that fails five times in a row is the
// only thing that stops. Core keeps ingesting, because every other module
// reads what core writes and a starved ledger fails silently.
import { describe, expect, it } from "vitest";
import { BREAKER_LIMIT } from "../src/module.js";
import { makeHarness } from "./fakes.js";

describe("a failing module", () => {
  it("trips its own breaker at five consecutive failures and leaves core running", async () => {
    const harness = makeHarness({
      "modules_core_enabled": true,
      "modules_spend_enabled": true,
    });
    const spend = harness.registry.context("spend");
    const core = harness.registry.context("core");
    const failing = spend.job("scan", () => {
      throw new Error("pricing catalog unreachable");
    });
    let coreRuns = 0;
    const coreJob = core.job("ingest", () => {
      coreRuns += 1;
    });

    for (let attempt = 0; attempt < BREAKER_LIMIT; attempt += 1) {
      // The wrapper never throws: that is what keeps a cron alive.
      await expect(failing()).resolves.toBeUndefined();
      await coreJob();
    }

    expect(spend.breaker().tripped).toBe(true);
    expect(spend.breaker().failures).toBe(BREAKER_LIMIT);
    expect(await spend.enabled()).toBe(false);
    expect(coreRuns).toBe(BREAKER_LIMIT);
    expect(core.breaker().tripped).toBe(false);
    expect(await core.enabled()).toBe(true);
    // The breaker is reported, not silent.
    expect(harness.harness.inspection.needsConfigurationMessages).toEqual([
      "observatory: module spend disabled after 5 failures: pricing catalog unreachable",
    ]);
  });

  it("never trips core itself, however often core fails", async () => {
    const harness = makeHarness({ "modules_core_enabled": true });
    const core = harness.registry.context("core");
    const failing = core.job("ingest", () => {
      throw new Error("event stream closed");
    });

    for (let attempt = 0; attempt < BREAKER_LIMIT * 2; attempt += 1) {
      await failing();
    }

    expect(core.breaker().tripped).toBe(false);
    expect(await core.enabled()).toBe(true);
    // The failures are still visible: logged, and counted for `status`.
    expect(core.breaker().failures).toBe(BREAKER_LIMIT * 2);
  });

  it("resets the count on a success, so intermittent failures never trip", async () => {
    const harness = makeHarness({ "modules_watch_enabled": true });
    const watch = harness.registry.context("watch");
    let shouldFail = true;
    const flaky = watch.job("rules", () => {
      if (shouldFail) throw new Error("transient");
      return "ok";
    });

    for (let attempt = 0; attempt < BREAKER_LIMIT - 1; attempt += 1) await flaky();
    shouldFail = false;
    await flaky();
    shouldFail = true;
    for (let attempt = 0; attempt < BREAKER_LIMIT - 1; attempt += 1) await flaky();

    expect(watch.breaker().tripped).toBe(false);
  });
});
