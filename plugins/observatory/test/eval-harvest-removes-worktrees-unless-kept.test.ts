// Harvest first, then teardown — and the evidence outlives the tree.
//
// A suite that kept every red worktree would fill a disk in a week, and one
// that removed them before copying would leave a failure nobody can diagnose.
// So the artifacts directory is written first and the tree goes away second,
// unless the case explicitly asked to keep a failure for debugging.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCaseFile } from "../src/eval/cases.js";
import { provisionWorktree } from "../src/eval/dryrun.js";
import { harvestCase, teardownWorktree } from "../src/eval/harvest.js";
import { caseYaml, git, makeGitFixture, writeCases } from "./eval-fixtures.js";
import type { GitFixture } from "./eval-fixtures.js";

describe("harvest copies the evidence out and then removes the worktree", () => {
  let fixture: GitFixture;
  beforeEach(() => {
    fixture = makeGitFixture();
  });
  afterEach(() => fixture.dispose());

  function provision(name: string, keepOnFail: boolean) {
    const dir = writeCases(fixture.root, {
      [name]: caseYaml(name, fixture, { dirty: [], keepOnFail }),
    });
    const value = loadCaseFile(join(dir, `${name}.yaml`)).value;
    expect(value).not.toBeNull();
    const worktree = join(fixture.root, "trees", name);
    provisionWorktree(value!, worktree, git);
    return { value: value!, worktree };
  }

  it("harvests the ledger, the retro and the diff, then sweeps the tree", () => {
    const { value, worktree } = provision("swept", false);
    mkdirSync(join(worktree, "docs", "specs", "OBS-9_thing"), { recursive: true });
    writeFileSync(
      join(worktree, "docs", "specs", "OBS-9_thing", "LEDGER.md"),
      "## runlog\n\n| step |\n",
    );
    mkdirSync(join(worktree, ".agents", "retro"), { recursive: true });
    writeFileSync(join(worktree, ".agents", "retro", "run.md"), "retro\n");
    writeFileSync(join(worktree, "total.txt"), "changed by the run\n");

    const artifactsRoot = join(fixture.root, "artifacts");
    const report = harvestCase({
      case: value,
      worktree,
      artifactsRoot,
      runId: "run-h",
      trial: 1,
      git,
    });

    expect(report.ledgerFound).toBe(true);
    expect(report.runFolders).toEqual(["OBS-9_thing"]);
    expect(report.retroFiles).toBe(1);
    expect(readFileSync(join(report.dir, "specs", "OBS-9_thing", "LEDGER.md"), "utf8")).toContain(
      "## runlog",
    );
    // The diff is taken against the pinned sha, so it holds the run's work
    // whether the run committed it or left it in the tree.
    expect(readFileSync(join(report.dir, "diff.patch"), "utf8")).toContain("changed by the run");

    expect(teardownWorktree({ case: value, worktree, failed: true, git })).toBe(true);
    expect(existsSync(worktree)).toBe(false);
    // The evidence is still there after the tree is gone. That is the point.
    expect(existsSync(join(report.dir, "diff.patch"))).toBe(true);
  });

  it("keeps a failed tree when the case asked for it, and sweeps a passing one", () => {
    const kept = provision("kept", true);
    expect(
      teardownWorktree({ case: kept.value, worktree: kept.worktree, failed: true, git }),
    ).toBe(false);
    expect(existsSync(kept.worktree)).toBe(true);

    // keep_on_fail is about failures only: a green trial never lingers.
    expect(
      teardownWorktree({ case: kept.value, worktree: kept.worktree, failed: false, git }),
    ).toBe(true);
    expect(existsSync(kept.worktree)).toBe(false);
  });
});
