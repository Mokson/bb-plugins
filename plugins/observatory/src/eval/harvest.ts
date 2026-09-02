// Pull the evidence out of a case worktree before the worktree is destroyed.
//
// Harvest runs BEFORE teardown and is deliberately separate from it, because
// the failure mode this module exists to prevent is a worktree that is gone
// and a run that cannot say why it failed. Everything the assertions read
// afterwards comes from the artifacts directory, never from the worktree — so
// a promoted baseline stays inspectable long after its tree is swept.
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EvalCase } from "./cases.js";
import { expandHome } from "./cases.js";
import type { GitRunner } from "./dryrun.js";
import { execGit, removeWorktree } from "./dryrun.js";

export interface HarvestInput {
  case: EvalCase;
  worktree: string;
  /** Root under the plugin data directory; a run gets one folder under it. */
  artifactsRoot: string;
  runId: string;
  trial: number;
  git?: GitRunner;
}

export interface HarvestReport {
  /** Absolute path of the artifacts directory, keyed by run and case. */
  dir: string;
  /** Spec folders copied, as `docs/specs/<slug>` relative paths. */
  runFolders: readonly string[];
  /** True when at least one spec folder held a LEDGER.md. */
  ledgerFound: boolean;
  retroFiles: number;
  diffBytes: number;
  /** Non-fatal problems; harvest never throws on a missing input. */
  notes: readonly string[];
}

/** `<artifactsRoot>/<runId>/<case>-<trial>`. Stable, so `eval show` can link it. */
export function artifactsDirFor(
  artifactsRoot: string,
  runId: string,
  caseName: string,
  trial: number,
): string {
  return join(artifactsRoot, runId, `${caseName}-${trial}`);
}

/** Every spec folder under docs/specs that holds a LEDGER.md. No glob dependency. */
export function ledgerSpecFolders(worktree: string): string[] {
  const specs = join(worktree, "docs", "specs");
  let entries: string[];
  try {
    if (!statSync(specs).isDirectory()) return [];
    entries = readdirSync(specs);
  } catch {
    return [];
  }
  return entries
    .filter((name) => existsSync(join(specs, name, "LEDGER.md")))
    .sort();
}

/**
 * Copy the run folders, the retro files and the diff into the artifacts dir.
 *
 * The diff is taken against the case's PINNED sha rather than as a bare
 * `git diff`, because a deliver run commits its work: a working-tree diff of
 * a run that committed cleanly is empty, which would make the most valuable
 * artifact the emptiest one.
 */
export function harvestCase(input: HarvestInput): HarvestReport {
  const git = input.git ?? execGit;
  const dir = artifactsDirFor(
    input.artifactsRoot,
    input.runId,
    input.case.name,
    input.trial,
  );
  mkdirSync(dir, { recursive: true });
  const notes: string[] = [];

  const runFolders = ledgerSpecFolders(input.worktree);
  for (const folder of runFolders) {
    cpSync(join(input.worktree, "docs", "specs", folder), join(dir, "specs", folder), {
      recursive: true,
    });
  }
  if (runFolders.length === 0) notes.push("no docs/specs/*/LEDGER.md in the worktree");

  let retroFiles = 0;
  const retro = join(input.worktree, ".agents", "retro");
  if (existsSync(retro)) {
    cpSync(retro, join(dir, "retro"), { recursive: true });
    retroFiles = readdirSync(join(dir, "retro")).length;
  }

  let diffBytes = 0;
  try {
    const diff = git(input.worktree, ["diff", input.case.fixture.sha]);
    writeFileSync(join(dir, "diff.patch"), diff.endsWith("\n") ? diff : `${diff}\n`);
    diffBytes = Buffer.byteLength(diff, "utf8");
  } catch (error) {
    // A worktree git can no longer read is still worth its ledgers. The note
    // reaches the operator; a throw here would lose everything above it.
    notes.push(`git diff failed: ${error instanceof Error ? error.message.trim() : String(error)}`);
  }

  return {
    dir,
    runFolders,
    ledgerFound: runFolders.length > 0,
    retroFiles,
    diffBytes,
    notes,
  };
}

export interface TeardownInput {
  case: EvalCase;
  worktree: string;
  /** True when the trial did not pass. */
  failed: boolean;
  git?: GitRunner;
}

/**
 * Remove the worktree unless the case asked to keep a failure. Returns
 * whether the tree was removed, which is what the run report prints.
 */
export function teardownWorktree(input: TeardownInput): boolean {
  if (input.failed && input.case.keep_on_fail) return false;
  removeWorktree(input.case.fixture.repo, input.worktree, input.git ?? execGit);
  return true;
}

/** Where artifacts live: beside the sqlite file, next to the worktrees. */
export function artifactsRootFor(databasePath?: string): string {
  return databasePath !== undefined && databasePath !== "" && databasePath !== ":memory:"
    ? join(dirname(databasePath), "eval-artifacts")
    : join(expandHome("~/.bb"), "plugins", "observatory", "eval-artifacts");
}
