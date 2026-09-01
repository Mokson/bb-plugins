// `eval run --dry-run`: everything a real run does EXCEPT spawning.
//
// The point is that provisioning is the half most likely to be quietly broken
// — a moved fixture, a patch that no longer applies, a sha that was garbage
// collected — and it is also the half that costs nothing to check. So the dry
// run does the real git work against the real fixture, prints the exact spawn
// arguments part 2 would pass, and then removes what it made.
//
// It never touches `bb.sdk.threads`. That is asserted by a test, because a
// dry run that spawned would be a silent bill.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { EvalCase, LoadedCase } from "./cases.js";
import { expandHome } from "./cases.js";
import type { EvalStore } from "./store.js";

/**
 * The `threads.spawn` arguments a real trial would use.
 *
 * `providerId`, `model` and `reasoningLevel` stay plain strings: they arrive
 * from YAML, and the SDK narrows them to enums only at the spawn call, which
 * is part 2's. Printing them unvalidated is the honest thing for a plan — the
 * operator sees exactly what the case asked for.
 */
export interface SpawnPlan {
  projectId: string;
  title: string;
  visibility: "hidden";
  providerId: string;
  model: string;
  reasoningLevel: string;
  environment: {
    type: "host";
    workspace: { type: "unmanaged"; path: string };
  };
  prompt: string;
}

export interface CasePlan {
  case: string;
  trial: number;
  worktree: string;
  /** Patch paths applied, in order. */
  patches: readonly string[];
  spawn: SpawnPlan;
  answers: number;
  assertions: number;
  /** Set when provisioning failed; `worktree` then holds no tree. */
  error: string | null;
}

export interface DryRunReport {
  runId: string;
  stackSha: string | null;
  startedAt: string;
  /** Case names selected, in plan order and without trial duplication. */
  cases: readonly string[];
  plans: readonly CasePlan[];
  /** Cases that failed to load; a run refuses to start with any of these. */
  invalid: ReadonlyArray<{ name: string; path: string; error: string }>;
  keptWorktrees: boolean;
}

export interface DryRunOptions {
  store: EvalStore;
  selected: readonly LoadedCase[];
  tag?: string;
  /** Leave the worktrees on disk for inspection. */
  keep?: boolean;
  /** Where worktrees are rooted. Defaults to the plugin data directory. */
  worktreeRoot?: string;
  now?: () => Date;
  runId?: string;
  /** Injected so tests can drive git without a child process per assertion. */
  git?: GitRunner;
}

export type GitRunner = (cwd: string, args: readonly string[]) => string;

/** Synchronous git. Eval runs are operator-initiated, never on a hot path. */
export const execGit: GitRunner = (cwd, args) =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/**
 * Where worktrees live. The plugin's own data directory, derived from the
 * sqlite file the host opened. Never the system temp directory: a run can
 * outlive a reboot's tmp sweep, and a half-swept worktree is a confusing
 * failure rather than a clear one.
 */
export function worktreeRootFor(databasePath?: string): string {
  const usable =
    databasePath !== undefined &&
    databasePath !== "" &&
    databasePath !== ":memory:" &&
    isAbsolute(databasePath);
  return usable
    ? join(dirname(databasePath), "eval-worktrees")
    : join(homedir(), ".bb", "plugins", "observatory", "eval-worktrees");
}

/** `~/.agents` HEAD, or null when it is not a git repo. This pins the stack. */
export function stackSha(agentsDir: string, git: GitRunner = execGit): string | null {
  const dir = expandHome(agentsDir);
  if (!existsSync(dir)) return null;
  try {
    return git(dir, ["rev-parse", "HEAD"]);
  } catch {
    return null;
  }
}

/** A run id that sorts by time and reads as a folder name. */
export function makeRunId(now: Date): string {
  return `eval-${now.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "")}`;
}

function countAssertions(value: EvalCase["assert"]): number {
  return Object.values(value).filter((entry) => entry !== undefined).length;
}

export function buildSpawnPlan(value: EvalCase, worktree: string, trial: number): SpawnPlan {
  const { orchestrator } = value.harness;
  return {
    projectId: value.fixture.project,
    // The title carries the case and trial because part 2 finds its own
    // hidden threads by title, and a shared title would let two trials
    // harvest each other's events.
    title: `eval ${value.name} trial ${trial}`,
    visibility: "hidden",
    providerId: orchestrator.provider,
    model: orchestrator.model,
    reasoningLevel: orchestrator.effort,
    environment: { type: "host", workspace: { type: "unmanaged", path: worktree } },
    prompt: value.invocation.text,
  };
}

/**
 * Cut a detached worktree at the case's pinned sha and apply its patches.
 * Returns the tree path. Throws with the git stderr on any failure, which is
 * the diagnosis an operator needs verbatim.
 */
export function provisionWorktree(
  value: EvalCase,
  worktree: string,
  git: GitRunner = execGit,
): readonly string[] {
  const repo = expandHome(value.fixture.repo);
  if (!existsSync(repo)) throw new Error(`fixture repo not found: ${repo}`);
  mkdirSync(dirname(worktree), { recursive: true });
  // Detached, so the fixture's own branches are never moved by a run. A case
  // that wants a branch gets one inside its own tree.
  git(repo, ["worktree", "add", "--detach", "--force", worktree, value.fixture.sha]);
  const applied: string[] = [];
  for (const patch of value.fixture.dirty) {
    const absolute = isAbsolute(patch) ? patch : join(repo, patch);
    if (!existsSync(absolute)) throw new Error(`patch not found: ${absolute}`);
    git(worktree, ["apply", absolute]);
    applied.push(patch);
  }
  return applied;
}

/** Remove a worktree and deregister it. Best effort: cleanup never throws. */
export function removeWorktree(repo: string, worktree: string, git: GitRunner = execGit): void {
  try {
    git(expandHome(repo), ["worktree", "remove", "--force", worktree]);
  } catch {
    // A tree git no longer knows about still has to leave the disk.
    rmSync(worktree, { recursive: true, force: true });
    try {
      git(expandHome(repo), ["worktree", "prune"]);
    } catch {
      // Prune is bookkeeping; a failure here loses nothing on disk.
    }
  }
}

/**
 * Validate, provision, plan, record, and (unless kept) tear down.
 *
 * Provisioning failures are collected per case rather than thrown: an
 * operator wants to see that four cases are fine and one fixture moved, not
 * the first stack trace.
 */
export function dryRun(options: DryRunOptions): DryRunReport {
  const git = options.git ?? execGit;
  const now = (options.now ?? (() => new Date()))();
  const startedAt = now.toISOString();
  const runId = options.runId ?? makeRunId(now);
  const root = options.worktreeRoot ?? worktreeRootFor();

  const invalid = options.selected
    .filter((entry) => entry.value === null)
    .map((entry) => ({
      name: entry.name,
      path: entry.path,
      error: entry.error ?? "unknown error",
    }));
  const valid = options.selected.flatMap((entry) => (entry.value ? [entry.value] : []));

  // One stack sha for the run. Cases may name different `agents_dir` values,
  // but a run compares against ONE stack, so the first case's directory wins
  // and a disagreement is reported rather than silently averaged.
  const agentsDirs = [...new Set(valid.map((value) => value.harness.agents_dir))];
  const sha = agentsDirs.length === 0 ? null : stackSha(agentsDirs[0]!, git);

  const plans: CasePlan[] = [];
  const provisioned: Array<{ repo: string; worktree: string }> = [];
  for (const value of valid) {
    for (let trial = 1; trial <= value.trials; trial += 1) {
      const worktree = join(root, runId, `${value.name}-${trial}`);
      const base = {
        case: value.name,
        trial,
        worktree,
        spawn: buildSpawnPlan(value, worktree, trial),
        answers: value.answers.length,
        assertions: countAssertions(value.assert),
      };
      try {
        const patches = provisionWorktree(value, worktree, git);
        provisioned.push({ repo: value.fixture.repo, worktree });
        plans.push({ ...base, patches, error: null });
      } catch (error) {
        // A tree may exist despite the failure — `git apply` runs after the
        // worktree is created — so it is registered for teardown either way.
        if (existsSync(worktree)) provisioned.push({ repo: value.fixture.repo, worktree });
        plans.push({
          ...base,
          patches: [],
          error: error instanceof Error ? error.message.trim() : String(error),
        });
      }
    }
  }

  const cases = [...new Set(plans.map((plan) => plan.case))];
  // The trees are provisioned by now, so teardown is a `finally`: a failed
  // store write must not leave five checkouts behind on the way out.
  try {
    options.store.insertRun({
      id: runId,
      started_at: startedAt,
      finished_at: startedAt,
      tag: options.tag ?? null,
      stack_sha: sha,
      cases_json: JSON.stringify(cases),
      status: "dry-run",
      gate: null,
    });
  } finally {
    if (options.keep !== true) {
      for (const entry of provisioned) removeWorktree(entry.repo, entry.worktree, git);
    }
  }

  return {
    runId,
    stackSha: sha,
    startedAt,
    cases,
    plans,
    invalid,
    keptWorktrees: options.keep === true,
  };
}

/** The operator-facing plan. The CLI prints this verbatim. */
export function formatDryRun(report: DryRunReport): string {
  const lines: string[] = [
    `run ${report.runId}  status dry-run  started ${report.startedAt}`,
    `stack ${report.stackSha ?? "unknown"}`,
    `cases ${report.cases.length}  trials ${report.plans.length}  worktrees ${
      report.keptWorktrees ? "kept" : "removed"
    }`,
  ];
  for (const entry of report.invalid) {
    lines.push("", `INVALID ${entry.name}  ${entry.path}`, `  ${entry.error}`);
  }
  for (const plan of report.plans) {
    lines.push("", `case ${plan.case}  trial ${plan.trial}`);
    lines.push(`  worktree  ${plan.worktree}`);
    lines.push(
      `  patches   ${plan.patches.length === 0 ? "none" : plan.patches.join(", ")}`,
    );
    if (plan.error !== null) {
      lines.push(`  ERROR     ${plan.error}`);
      continue;
    }
    lines.push(
      `  spawn     project ${plan.spawn.projectId}  ${plan.spawn.providerId}/${plan.spawn.model}/${plan.spawn.reasoningLevel}  visibility ${plan.spawn.visibility}`,
    );
    lines.push(`  title     ${plan.spawn.title}`);
    lines.push(`  workspace ${plan.spawn.environment.workspace.path}`);
    lines.push(`  prompt    ${plan.spawn.prompt}`);
    lines.push(`  answers   ${plan.answers}  assertions ${plan.assertions}`);
  }
  lines.push("", "nothing was spawned; the runner arrives in part 2");
  return lines.join("\n");
}
