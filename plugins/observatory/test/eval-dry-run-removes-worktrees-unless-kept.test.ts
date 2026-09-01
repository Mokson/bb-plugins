// TECH.md risk: "Eval worktrees and hidden threads leak on failure." A dry
// run provisions real trees on every invocation, so the default MUST be to
// remove them; `--keep` is the deliberate exception for inspecting one.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadCaseFile } from "../src/eval/cases.js";
import { dryRun, removeWorktree } from "../src/eval/dryrun.js";
import { EvalStore } from "../src/eval/store.js";
import { TempDatabase } from "./fakes.js";
import { caseYaml, git, makeGitFixture, writeCases } from "./eval-fixtures.js";

const fixture = makeGitFixture();
const temp = new TempDatabase();
afterAll(() => {
  fixture.dispose();
  temp.dispose();
});

function loadOne(name: string, trials = 1) {
  const dir = writeCases(fixture.root, { [name]: caseYaml(name, fixture, { trials }) });
  const loaded = loadCaseFile(join(dir, `${name}.yaml`));
  expect(loaded.error).toBeNull();
  return loaded;
}

describe("dry-run removes its worktrees unless --keep", () => {
  it("removes every tree by default, and deregisters them from the repo", () => {
    const store = new EvalStore(temp.openDatabase());
    const report = dryRun({
      store,
      selected: [loadOne("swept", 2)],
      worktreeRoot: join(fixture.root, "swept-root"),
      runId: "run-swept",
    });

    expect(report.plans).toHaveLength(2);
    expect(report.keptWorktrees).toBe(false);
    for (const plan of report.plans) {
      expect(plan.error).toBeNull();
      expect(existsSync(plan.worktree)).toBe(false);
    }
    // A removed directory that git still lists is a leak with a longer fuse.
    expect(git(fixture.repo, ["worktree", "list"])).not.toContain("run-swept");
  });

  it("keeps the trees, patched and at the pinned sha, under --keep", () => {
    const store = new EvalStore(temp.openDatabase());
    const report = dryRun({
      store,
      selected: [loadOne("kept")],
      worktreeRoot: join(fixture.root, "kept-root"),
      runId: "run-kept",
      keep: true,
    });

    const plan = report.plans[0]!;
    expect(report.keptWorktrees).toBe(true);
    expect(existsSync(plan.worktree)).toBe(true);
    expect(git(plan.worktree, ["rev-parse", "HEAD"])).toBe(fixture.baseSha);
    expect(readFileSync(join(plan.worktree, "total.txt"), "utf8")).toBe("patched\n");

    removeWorktree(fixture.repo, plan.worktree);
  });

  it("gives each trial its own tree, so two trials cannot share state", () => {
    const store = new EvalStore(temp.openDatabase());
    const report = dryRun({
      store,
      selected: [loadOne("isolated", 3)],
      worktreeRoot: join(fixture.root, "isolated-root"),
      runId: "run-isolated",
    });
    const paths = report.plans.map((plan) => plan.worktree);
    expect(new Set(paths).size).toBe(3);
    expect(report.plans.map((plan) => plan.trial)).toEqual([1, 2, 3]);
  });
});
