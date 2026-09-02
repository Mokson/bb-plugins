// A case pins a SHA, not a branch, and the fixture repo has moved past it.
// If provisioning resolved the branch instead, every case would silently
// measure a tree nobody pinned — and the eval would still look green.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadCaseFile } from "../src/eval/cases.js";
import { dryRun, provisionWorktree, removeWorktree } from "../src/eval/dryrun.js";
import { EvalStore } from "../src/eval/store.js";
import { TempDatabase } from "./fakes.js";
import { caseYaml, git, makeGitFixture, writeCases } from "./eval-fixtures.js";

const fixture = makeGitFixture();
const temp = new TempDatabase();
afterAll(() => {
  fixture.dispose();
  temp.dispose();
});

function loadOne(name: string, dirty?: readonly string[]) {
  const dir = writeCases(fixture.root, {
    [name]: caseYaml(name, fixture, dirty === undefined ? {} : { dirty }),
  });
  const loaded = loadCaseFile(join(dir, `${name}.yaml`));
  expect(loaded.error).toBeNull();
  return loaded;
}

describe("the worktree is cut at the pinned sha and the patch applies", () => {
  it("checks out the pinned commit, not the branch tip", () => {
    const loaded = loadOne("pinned");
    const worktree = join(fixture.root, "trees", "pinned-1");
    const applied = provisionWorktree(loaded.value!, worktree);

    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(fixture.baseSha);
    expect(git(worktree, ["rev-parse", "HEAD"])).not.toBe(fixture.headSha);
    expect(applied).toEqual([fixture.patch]);
    // The patch turned the base content into "patched"; the branch tip says
    // "moved on", so this one read separates the two failure modes.
    expect(readFileSync(join(worktree, "total.txt"), "utf8")).toBe("patched\n");

    removeWorktree(fixture.repo, worktree);
  });

  it("leaves a clean tree when the case declares no patches", () => {
    const loaded = loadOne("clean-tree", []);
    const worktree = join(fixture.root, "trees", "clean-1");
    expect(provisionWorktree(loaded.value!, worktree)).toEqual([]);
    expect(readFileSync(join(worktree, "total.txt"), "utf8")).toBe("base\n");
    removeWorktree(fixture.repo, worktree);
  });

  it("reports a missing patch per case instead of aborting the run", () => {
    const loaded = loadOne("absent-patch", ["patches/does-not-exist.patch"]);
    const store = new EvalStore(temp.openDatabase());
    const report = dryRun({
      store,
      selected: [loaded],
      worktreeRoot: join(fixture.root, "missing-patch"),
      runId: "run-missing-patch",
    });

    expect(report.plans).toHaveLength(1);
    expect(report.plans[0]!.error).toContain("patch not found");
    expect(report.plans[0]!.patches).toEqual([]);
    // Provisioning failed AFTER the tree was created, so teardown still ran.
    expect(existsSync(report.plans[0]!.worktree)).toBe(false);
    // And the run is still recorded: a failed dry run is evidence, not a void.
    expect(store.run("run-missing-patch")?.status).toBe("dry-run");
  });
});
