// The one property that makes `--dry-run` safe to run on a laptop at any
// hour: it does not spawn. A dry run that reached `threads.spawn` would be a
// real bill and a real agent loose on a real project.
//
// The fake host records every sdk path touched and THROWS on any path that is
// not stubbed, so an accidental spawn fails loudly rather than silently.
import { afterAll, describe, expect, it } from "vitest";
import { runEvalCommand } from "../src/eval/cli.js";
import { EvalStore } from "../src/eval/store.js";
import { makeHarness } from "./fakes.js";
import { caseYaml, makeGitFixture, writeCases } from "./eval-fixtures.js";

const fixture = makeGitFixture();
afterAll(() => fixture.dispose());

describe("dry-run spawns nothing", () => {
  it("touches no sdk thread surface across list, validate and run", () => {
    const host = makeHarness();
    const deps = {
      store: new EvalStore(host.bb.storage.database()),
      casesDir: writeCases(fixture.root, {
        "spawn-free": caseYaml("spawn-free", fixture),
      }),
    };
    const worktreeRoot = `${fixture.root}/worktrees`;

    expect(runEvalCommand(deps, ["list"], undefined).exitCode).toBe(0);
    expect(runEvalCommand(deps, ["validate"], undefined).exitCode).toBe(0);
    const result = runEvalCommand(
      deps,
      ["run", "--dry-run"],
      `${worktreeRoot}/data.db`,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("nothing was spawned");
    expect(host.harness.sdk.calls).toEqual([]);
  });

  it("prints the spawn arguments it declined to use", () => {
    const host = makeHarness();
    const deps = {
      store: new EvalStore(host.bb.storage.database()),
      casesDir: writeCases(fixture.root, {
        "planned": caseYaml("planned", fixture),
      }),
    };
    const result = runEvalCommand(
      deps,
      ["run", "--dry-run"],
      `${fixture.root}/plan/data.db`,
    );
    const stdout = result.stdout ?? "";
    expect(stdout).toContain("project proj_test");
    expect(stdout).toContain("claude-code/claude-sonnet-5/low");
    expect(stdout).toContain("visibility hidden");
    expect(stdout).toContain("/deliver tracker:none do the thing");
    expect(host.harness.sdk.calls).toEqual([]);
  });

  it("refuses a non-dry run with exit 2 rather than half-running one", () => {
    const host = makeHarness();
    const deps = {
      store: new EvalStore(host.bb.storage.database()),
      casesDir: writeCases(fixture.root, { "live": caseYaml("live", fixture) }),
    };
    const result = runEvalCommand(deps, ["run"], undefined);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("part 2");
    expect(host.harness.sdk.calls).toEqual([]);
  });
});
