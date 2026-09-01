// One status builder, two surfaces. The CLI text is a rendering of the same
// object the rpc returns, so an operator reading `bb observatory status` and a
// reader looking at the panel can never see different module states.
import { describe, expect, it } from "vitest";
import { statusSchema } from "../src/contract.js";
import { MODULE_IDS, buildStatus, formatStatus, runDoctor } from "../src/server.js";
import { makeHarness } from "./fakes.js";

const NOW = "2026-09-01T00:00:00.000Z";

function statusOf(harness: ReturnType<typeof makeHarness>) {
  return buildStatus({
    bb: harness.bb,
    store: harness.store,
    registry: harness.registry,
    settings: harness.settings,
    now: () => NOW,
  });
}

describe("status", () => {
  it("returns every module, and the CLI text renders that same object", async () => {
    const harness = makeHarness(
      Object.fromEntries(MODULE_IDS.map((id) => [`modules_${id}_enabled`, true])),
    );
    harness.store.upsertThread({ thread_id: "t1" });
    harness.store.upsertTurn({ thread_id: "t1", turn_id: "turn-1" });

    const status = await statusOf(harness);
    // The rpc validates its output against this schema before it ships, so a
    // shape the panel cannot read fails here rather than in the browser.
    expect(statusSchema.parse(status)).toEqual(status);
    expect(status.modules.map((module) => module.id)).toEqual([...MODULE_IDS]);
    expect(status.counts).toMatchObject({ threads: 1, turns: 1 });

    const text = formatStatus(status);
    for (const module of status.modules) {
      expect(text).toContain(module.id);
    }
    expect(text).toContain("threads     1");
    expect(text).toContain("turns       1");
  });

  it("shows a tripped module as tripped on both surfaces", async () => {
    const harness = makeHarness({ "modules_spend_enabled": true });
    const spend = harness.registry.context("spend");
    const failing = spend.job("scan", () => {
      throw new Error("boom");
    });
    for (let attempt = 0; attempt < 5; attempt += 1) await failing();

    const status = await statusOf(harness);

    const row = status.modules.find((module) => module.id === "spend")!;
    expect(row).toMatchObject({ tripped: true, enabled: false, failures: 5 });
    expect(formatStatus(status)).toContain("tripped (5 failures)");
  });
});

describe("doctor", () => {
  it("confirms the database opens and the ledger tables exist", () => {
    const harness = makeHarness();

    const checks = runDoctor(harness.store, []);

    expect(checks.find((check) => check.name === "database")).toMatchObject({
      ok: true,
    });
    const migrations = checks.find((check) => check.name === "migrations")!;
    expect(migrations.ok).toBe(true);
    expect(migrations.detail).toMatch(/^\d+ ledger tables$/);
  });

  it("reports each provider root as present or absent without failing", () => {
    const harness = makeHarness();

    const checks = runDoctor(harness.store, ["/definitely/not/here"]);

    const roots = checks.filter((check) => check.name.startsWith("root "));
    expect(roots).toHaveLength(6);
    for (const root of roots) expect(root.detail).toMatch(/ exists (yes|no)$/);
    expect(roots.at(-1)).toMatchObject({
      name: "root extra",
      ok: false,
    });
  });
});
