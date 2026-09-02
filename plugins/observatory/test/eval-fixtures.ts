// Eval test doubles: a throwaway git fixture repo and a case that points at
// it. Hermetic on purpose — the shipped cases point at ~/fixtures, which is a
// machine fact, and a unit test must not depend on one.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "eval",
      GIT_AUTHOR_EMAIL: "eval@example.invalid",
      GIT_COMMITTER_NAME: "eval",
      GIT_COMMITTER_EMAIL: "eval@example.invalid",
    },
  }).trim();
}

export interface GitFixture {
  root: string;
  repo: string;
  /** The commit a case pins. A LATER commit exists, so a case that resolved
   *  the branch instead of the sha would visibly land on the wrong tree. */
  baseSha: string;
  headSha: string;
  /** Path relative to `repo`, as a case's `fixture.dirty` entry. */
  patch: string;
  dispose(): void;
}

/**
 * A repo with two commits and a patch against the FIRST one. The second
 * commit is what makes the pinned-sha assertion meaningful.
 */
export function makeGitFixture(): GitFixture {
  const root = mkdtempSync(join(tmpdir(), "observatory-eval-"));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "--initial-branch", "fixture/base"]);
  writeFileSync(join(repo, "total.txt"), "base\n");
  git(repo, ["add", "total.txt"]);
  git(repo, ["commit", "-m", "base"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);

  mkdirSync(join(repo, "patches"), { recursive: true });
  writeFileSync(
    join(repo, "patches", "off-by-one.patch"),
    [
      "diff --git a/total.txt b/total.txt",
      "--- a/total.txt",
      "+++ b/total.txt",
      "@@ -1 +1 @@",
      "-base",
      "+patched",
      "",
    ].join("\n"),
  );
  writeFileSync(join(repo, "total.txt"), "moved on\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "later"]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);

  return {
    root,
    repo,
    baseSha,
    headSha,
    patch: "patches/off-by-one.patch",
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A minimal valid case as YAML text, so tests exercise the real loader. */
export function caseYaml(
  name: string,
  fixture: GitFixture,
  overrides: {
    dirty?: readonly string[];
    tags?: readonly string[];
    trials?: number;
    /** Replaces the `answers:` block body, indented two spaces. */
    answers?: readonly string[];
    keepOnFail?: boolean;
  } = {},
): string {
  const dirty = overrides.dirty ?? [fixture.patch];
  const tags = overrides.tags ?? ["smoke"];
  const answers = overrides.answers ?? [
    "  - match: {}",
    '    respond: "proceed with your recommended option"',
    "    default: { max_uses: 6 }",
  ];
  return [
    `name: ${name}`,
    `tags: [${tags.join(", ")}]`,
    `trials: ${overrides.trials ?? 1}`,
    `keep_on_fail: ${overrides.keepOnFail === true}`,
    "fixture:",
    "  project: proj_test",
    `  repo: ${fixture.repo}`,
    "  base_branch: fixture/base",
    `  sha: ${fixture.baseSha}`,
    `  dirty: [${dirty.join(", ")}]`,
    "invocation:",
    '  text: "/deliver tracker:none do the thing"',
    "harness:",
    "  tracker: none",
    "  agents_dir: ~/.agents",
    "  tier_models:",
    "    defined: { provider: claude-code, model: claude-sonnet-5, effort: low }",
    "  orchestrator: { provider: claude-code, model: claude-sonnet-5, effort: low }",
    "limits:",
    "  timeout_ms: 1_800_000",
    "  cost_ceiling_usd: 8",
    "  max_total_tokens: 4_000_000",
    "answers:",
    ...answers,
    "assert:",
    "  ledger:",
    "    exists: true",
    "    sections_present: [runlog]",
    "",
  ].join("\n");
}

/** A directory of case files, written from `caseYaml` text. */
export function writeCases(root: string, files: Record<string, string>): string {
  const dir = join(root, "cases");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, `${name}.yaml`), text);
  }
  return dir;
}

/** One pending interaction, shaped like `interactions.list` returns it. */
export interface FakeInteraction {
  id: string;
  status: string;
  payload: { kind: string; title: string; data?: unknown };
}

export interface RunnerHostOptions {
  /** Statuses served by `threads.get`, one per call; the last one repeats. */
  statuses?: readonly string[];
  /** Interactions served by `interactions.list`, one page per call. */
  interactions?: ReadonlyArray<readonly FakeInteraction[]>;
  output?: string | null;
  /** Threads `threads.list` serves, for the exactly-once lookup. */
  existing?: ReadonlyArray<{ id: string; title: string }>;
  spawnId?: string;
  /**
   * Projects `projects.list` serves. The runner reads the spawn's host off
   * the project's default source, so a case's `fixture.project` must be in
   * here for the spawn to name a machine at all.
   */
  projects?: ReadonlyArray<{
    id: string;
    sources: ReadonlyArray<{ hostId: string; isDefault: boolean }>;
  }>;
}

export interface RunnerHost {
  stopped: string[];
  answered: Array<{ interactionId: string; value: unknown }>;
  spawns: number;
  /** Every `threads.spawn` request, in order, exactly as the SDK saw it. */
  spawnArgs: unknown[];
}

/** The project a fixture case names, on the one host that holds its checkout. */
export const FIXTURE_PROJECT_ID = "proj_test";
export const FIXTURE_HOST_ID = "host_fixture";

/**
 * Stub every `bb.sdk.threads` surface the runner touches on an existing fake
 * host. Only these paths are stubbed on purpose: an unstubbed call throws, so
 * a runner that reached for a surface no test expected fails loudly.
 */
export function stubRunnerThreads(
  harness: { sdk: { stub(path: string, implementation: (...args: never[]) => unknown): void } },
  options: RunnerHostOptions = {},
): RunnerHost {
  const state: RunnerHost = { stopped: [], answered: [], spawns: 0, spawnArgs: [] };
  const statuses = options.statuses ?? ["idle"];
  const interactions = options.interactions ?? [];
  let getCalls = 0;
  let listCalls = 0;

  harness.sdk.stub("projects.list", () => [
    ...(options.projects ?? [
      {
        id: FIXTURE_PROJECT_ID,
        sources: [{ hostId: FIXTURE_HOST_ID, isDefault: true }],
      },
    ]),
  ]);
  harness.sdk.stub("threads.list", () => [...(options.existing ?? [])]);
  harness.sdk.stub("threads.spawn", (args: never) => {
    state.spawns += 1;
    state.spawnArgs.push(args);
    return { id: options.spawnId ?? "thr-eval" };
  });
  harness.sdk.stub("threads.get", () => {
    const status = statuses[Math.min(getCalls, statuses.length - 1)];
    getCalls += 1;
    return { status };
  });
  harness.sdk.stub("threads.interactions.list", () => {
    const page = interactions[Math.min(listCalls, interactions.length - 1)] ?? [];
    listCalls += 1;
    return [...page];
  });
  harness.sdk.stub("threads.interactions.respond", (args: never) => {
    const shaped = args as unknown as { interactionId: string; value: unknown };
    state.answered.push({ interactionId: shaped.interactionId, value: shaped.value });
    return {};
  });
  harness.sdk.stub("threads.stop", (args: never) => {
    state.stopped.push((args as unknown as { threadId: string }).threadId);
    return { ok: true };
  });
  harness.sdk.stub("threads.output", () => ({ output: options.output ?? null }));
  harness.sdk.stub("threads.events.wait", () => null);
  return state;
}
