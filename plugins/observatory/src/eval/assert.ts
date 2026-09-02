// The assertion engine: structural keys first, the judge only after they pass.
//
// PRODUCT.md invariant 29 — "There is no expression language. An unknown key
// fails the case" — is enforced twice on purpose. The schema in `cases.ts`
// refuses an unknown key at load, and `ASSERT_KEYS` below refuses one at
// evaluation, so a future schema loosening cannot silently produce a case
// whose assertion nobody runs. A key nobody checks that reports `pass` is the
// failure mode this module is built against.
//
// The judge is gated behind the structural verdict for the same reason a
// human reviewer is: asking a model whether a run was good, when the ledger
// is missing and the tests are red, buys an expensive opinion about nothing.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { EvalAssert, EvalCase } from "./cases.js";
import { expandHome } from "./cases.js";
import type { HarvestReport } from "./harvest.js";
import type { TreeMetrics } from "./metrics.js";

/** Every key the engine knows how to evaluate. Anything else is a failure. */
export const ASSERT_KEYS = [
  "ledger",
  "artifacts",
  "exit_codes",
  "trace",
  "output",
  "judge",
  "skills_tree_unchanged",
] as const;

export interface AssertionOutcome {
  /** The assertion's key path, e.g. `trace.max_cost_usd`. */
  key: string;
  pass: boolean;
  detail: string;
}

export interface AssertionReport {
  pass: boolean;
  outcomes: readonly AssertionOutcome[];
}

/** Injected so tests never shell out and a slow case never hangs a suite. */
export type CommandRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
) => { code: number; stdout: string };

export const execShell: CommandRunner = (command, cwd, timeoutMs) => {
  try {
    const stdout = execFileSync("/bin/sh", ["-c", command], {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (error) {
    const shaped = error as { status?: number | null; stdout?: string };
    // A signal kill reports a null status. 124 is the conventional timeout
    // code, and reporting it beats reporting a pass.
    return { code: shaped.status ?? 124, stdout: shaped.stdout ?? "" };
  }
};

export const DEFAULT_CHECK_LEDGER = "~/.agents/skills/deliver/scripts/check-ledger.sh";

export interface StructuralInput {
  case: EvalCase;
  /** The case worktree. Assertion paths and commands resolve against it. */
  worktree: string;
  harvest: HarvestReport;
  metrics: TreeMetrics;
  /** The spawned thread's final output, or null when it produced none. */
  output: string | null;
  /** `~/.agents` HEAD at spawn time, for `skills_tree_unchanged`. */
  stackShaAtStart: string | null;
  checkLedgerScript?: string;
  run?: CommandRunner;
}

function ok(key: string, detail: string): AssertionOutcome {
  return { key, pass: true, detail };
}

function bad(key: string, detail: string): AssertionOutcome {
  return { key, pass: false, detail };
}

function limit(
  key: string,
  actual: number,
  max: number,
  unit: string,
): AssertionOutcome {
  return actual <= max
    ? ok(key, `${actual}${unit} <= ${max}${unit}`)
    : bad(key, `${actual}${unit} exceeds ${max}${unit}`);
}

interface LedgerJson {
  rows?: number;
  fails?: number;
  warns?: number;
}

function checkLedger(input: StructuralInput, out: AssertionOutcome[]): void {
  const spec = input.case.assert.ledger;
  if (spec === undefined) return;
  const folders = input.harvest.runFolders;
  if (!spec.exists) {
    out.push(
      folders.length === 0
        ? ok("ledger.exists", "no ledger, as asserted")
        : bad("ledger.exists", `expected no ledger, found ${folders.join(", ")}`),
    );
    return;
  }
  if (folders.length === 0) {
    out.push(bad("ledger.exists", "no docs/specs/*/LEDGER.md was produced"));
    return;
  }
  out.push(ok("ledger.exists", folders.join(", ")));

  // The harvested copy, not the worktree's: assertions must read the same
  // bytes a later inspection of the artifacts will.
  const path = join(input.harvest.dir, "specs", folders[0]!, "LEDGER.md");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";

  for (const section of spec.sections_present) {
    const present = new RegExp(`^##+\\s+${section}\\s*$`, "im").test(text);
    out.push(
      present
        ? ok("ledger.sections_present", `## ${section}`)
        : bad("ledger.sections_present", `missing section "${section}"`),
    );
  }

  if (spec.done_when_status !== undefined) {
    const wanted = spec.done_when_status.toLowerCase();
    const body = /^##+\s+done-when\s*$([\s\S]*?)(?=^##+\s|\Z)/im.exec(text)?.[1] ?? "";
    out.push(
      body.toLowerCase().includes(wanted)
        ? ok("ledger.done_when_status", wanted)
        : bad("ledger.done_when_status", `Done-when does not report "${wanted}"`),
    );
  }

  const script = expandHome(input.checkLedgerScript ?? DEFAULT_CHECK_LEDGER);
  if (!existsSync(script)) {
    out.push(bad("ledger.check", `check-ledger.sh not found at ${script}`));
    return;
  }
  const runner = input.run ?? execShell;
  const result = runner(
    `${JSON.stringify(script)} ${JSON.stringify(path)} --json`,
    input.worktree,
    60_000,
  );
  let parsed: LedgerJson | null = null;
  try {
    parsed = JSON.parse(result.stdout) as LedgerJson;
  } catch {
    parsed = null;
  }
  if (parsed === null) {
    out.push(bad("ledger.check", `check-ledger.sh produced no JSON (exit ${result.code})`));
    return;
  }
  out.push(
    (parsed.fails ?? 0) === 0
      ? ok("ledger.check", `${parsed.rows ?? 0} rows, ${parsed.warns ?? 0} warnings`)
      : bad("ledger.check", `${parsed.fails} runlog failures`),
  );
  if (spec.gates_count_min !== undefined) {
    out.push(
      (parsed.rows ?? 0) >= spec.gates_count_min
        ? ok("ledger.gates_count_min", `${parsed.rows} rows`)
        : bad("ledger.gates_count_min", `${parsed.rows ?? 0} rows below ${spec.gates_count_min}`),
    );
  }
  if (spec.nudges_max !== undefined) {
    const nudges = (/^##+\s+nudges\s*$([\s\S]*?)(?=^##+\s|\Z)/im.exec(text)?.[1] ?? "")
      .split("\n")
      .filter((line) => /^\s*[-*]\s+\S/.test(line)).length;
    out.push(limit("ledger.nudges_max", nudges, spec.nudges_max, ""));
  }
}

function checkArtifacts(input: StructuralInput, out: AssertionOutcome[]): void {
  const spec = input.case.assert.artifacts;
  if (spec === undefined) return;
  // Paths resolve against the WORKTREE: a case asserts about what the run
  // produced, and the artifacts copy is a subset chosen by harvest.
  const resolve = (path: string) => join(input.worktree, path);
  for (const path of spec.exists) {
    out.push(
      existsSync(resolve(path))
        ? ok("artifacts.exists", path)
        : bad("artifacts.exists", `missing ${path}`),
    );
  }
  for (const path of spec.absent) {
    out.push(
      existsSync(resolve(path))
        ? bad("artifacts.absent", `${path} exists and should not`)
        : ok("artifacts.absent", path),
    );
  }
  for (const [path, ceiling] of Object.entries(spec.size_ceilings)) {
    const full = resolve(path);
    if (!existsSync(full)) {
      out.push(bad("artifacts.size_ceilings", `missing ${path}`));
      continue;
    }
    out.push(limit("artifacts.size_ceilings", statSync(full).size, ceiling, " bytes"));
  }
}

function checkExitCodes(input: StructuralInput, out: AssertionOutcome[]): void {
  const spec = input.case.assert.exit_codes;
  if (spec === undefined) return;
  const runner = input.run ?? execShell;
  for (const entry of spec) {
    const result = runner(entry.cmd, input.worktree, input.case.limits.timeout_ms);
    out.push(
      result.code === entry.expect
        ? ok("exit_codes", `${entry.cmd} exited ${result.code}`)
        : bad("exit_codes", `${entry.cmd} exited ${result.code}, expected ${entry.expect}`),
    );
  }
}

function checkTrace(input: StructuralInput, out: AssertionOutcome[]): void {
  const spec = input.case.assert.trace;
  if (spec === undefined) return;
  const m = input.metrics;
  out.push(limit("trace.max_turns", m.turns, spec.max_turns, ""));
  out.push(limit("trace.max_tool_calls", m.toolCalls, spec.max_tool_calls, ""));
  out.push(limit("trace.max_tokens", m.tokens, spec.max_tokens, ""));
  out.push(
    limit("trace.max_cost_usd", Number(m.costUsd.toFixed(4)), spec.max_cost_usd, " usd"),
  );
  out.push(limit("trace.max_wall_ms", m.wallMs, spec.max_wall_ms, "ms"));
  if (spec.no_provider_errors) {
    out.push(
      m.providerErrors === 0
        ? ok("trace.no_provider_errors", "none")
        : bad("trace.no_provider_errors", `${m.providerErrors} turns carried a provider error`),
    );
  }
  if (spec.subthreads_min !== undefined) {
    out.push(
      m.subthreads >= spec.subthreads_min
        ? ok("trace.subthreads_min", `${m.subthreads} subthreads`)
        : bad("trace.subthreads_min", `${m.subthreads} subthreads below ${spec.subthreads_min}`),
    );
  }
}

function checkOutput(input: StructuralInput, out: AssertionOutcome[]): void {
  const spec = input.case.assert.output;
  if (spec === undefined) return;
  const text = input.output ?? "";
  for (const needle of spec.contains) {
    out.push(
      text.includes(needle)
        ? ok("output.contains", needle)
        : bad("output.contains", `output does not contain "${needle}"`),
    );
  }
  for (const needle of spec.not_contains) {
    out.push(
      text.includes(needle)
        ? bad("output.not_contains", `output contains "${needle}"`)
        : ok("output.not_contains", needle),
    );
  }
  for (const pattern of spec.matches) {
    let matched: boolean;
    try {
      matched = new RegExp(pattern, "m").test(text);
    } catch (error) {
      out.push(
        bad("output.matches", `bad regex "${pattern}": ${(error as Error).message}`),
      );
      continue;
    }
    out.push(
      matched
        ? ok("output.matches", pattern)
        : bad("output.matches", `output does not match /${pattern}/`),
    );
  }
}

function checkSkillsTree(input: StructuralInput, out: AssertionOutcome[]): void {
  const spec = input.case.assert.skills_tree_unchanged;
  if (spec !== true) return;
  const dir = expandHome(input.case.harness.agents_dir);
  const runner = input.run ?? execShell;
  const head = runner("git rev-parse HEAD", dir, 30_000);
  const dirty = runner("git status --porcelain", dir, 30_000);
  if (head.code !== 0) {
    out.push(bad("skills_tree_unchanged", `cannot read ${dir} HEAD`));
    return;
  }
  const moved =
    input.stackShaAtStart !== null && head.stdout.trim() !== input.stackShaAtStart;
  const changed = dirty.stdout.trim() !== "";
  out.push(
    moved || changed
      ? bad(
          "skills_tree_unchanged",
          moved ? `${dir} HEAD moved during the run` : `${dir} has uncommitted changes`,
        )
      : ok("skills_tree_unchanged", `${dir} clean at ${head.stdout.trim().slice(0, 12)}`),
  );
}

/**
 * Evaluate every structural key. The judge is NOT run here: it costs money
 * and is only meaningful once the mechanical checks agree.
 */
export function runStructuralAssertions(input: StructuralInput): AssertionReport {
  const outcomes: AssertionOutcome[] = [];
  const known = new Set<string>(ASSERT_KEYS);
  for (const key of Object.keys(input.case.assert as Record<string, unknown>)) {
    if (!known.has(key)) outcomes.push(bad(key, `unknown assertion key "${key}"`));
  }
  checkLedger(input, outcomes);
  checkArtifacts(input, outcomes);
  checkExitCodes(input, outcomes);
  checkTrace(input, outcomes);
  checkOutput(input, outcomes);
  checkSkillsTree(input, outcomes);
  if (outcomes.length === 0) outcomes.push(ok("<none>", "the case declares no assertions"));
  return { pass: outcomes.every((entry) => entry.pass), outcomes };
}

// ---------------------------------------------------------------------------
// The judge
// ---------------------------------------------------------------------------

export interface JudgeVerdict {
  verdict: "pass" | "fail";
  reason: string;
}

export interface JudgeInput {
  bb: BbPluginApi;
  projectId: string;
  judge: NonNullable<EvalAssert["judge"]>;
  /** The harvested artifacts directory the rubric is applied to. */
  artifactsDir: string;
  /**
   * Evidence text supplied directly instead of read from disk. `judge-validate`
   * uses it so a labelled fixture grades the same bytes on every machine.
   */
  inlineEvidence?: string;
  /** Bytes of harvested evidence pasted into the prompt. */
  evidenceBudget?: number;
  timeoutMs?: number;
}

export const JUDGE_EVIDENCE_BUDGET = 40_000;

/** Read the harvested files a judge should see, newest-shaped and bounded. */
export function judgeEvidence(dir: string, budget = JUDGE_EVIDENCE_BUDGET): string {
  const parts: string[] = [];
  let spent = 0;
  const walk = (path: string, label: string): void => {
    if (spent >= budget) return;
    let entry: ReturnType<typeof statSync>;
    try {
      entry = statSync(path);
    } catch {
      return;
    }
    if (entry.isDirectory()) {
      for (const name of readdirSync(path).sort()) walk(join(path, name), `${label}/${name}`);
      return;
    }
    const text = readFileSync(path, "utf8").slice(0, budget - spent);
    spent += text.length;
    parts.push(`--- ${label} ---\n${text}`);
  };
  walk(dir, ".");
  return parts.join("\n\n");
}

/** The strict-JSON contract. A judge that prose-answers is a failed judge. */
export function judgePrompt(rubric: string, evidence: string): string {
  return [
    "You are grading one agent delivery run against a rubric.",
    "",
    "RUBRIC:",
    rubric,
    "",
    "EVIDENCE:",
    evidence,
    "",
    'Reply with ONE line of JSON and nothing else: {"verdict":"pass"|"fail","reason":"<one sentence>"}.',
  ].join("\n");
}

/** Parse the verdict. Anything that is not the exact contract is a failure. */
export function parseJudgeVerdict(text: string | null): JudgeVerdict {
  if (text === null || text.trim() === "") {
    return { verdict: "fail", reason: "the judge produced no output" };
  }
  const match = /\{[\s\S]*\}/.exec(text);
  if (match === null) return { verdict: "fail", reason: "the judge produced no JSON object" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { verdict: "fail", reason: "the judge produced unparseable JSON" };
  }
  const shaped = parsed as { verdict?: unknown; reason?: unknown };
  if (shaped.verdict !== "pass" && shaped.verdict !== "fail") {
    return { verdict: "fail", reason: `the judge returned verdict ${String(shaped.verdict)}` };
  }
  return {
    verdict: shaped.verdict,
    reason: typeof shaped.reason === "string" ? shaped.reason : "",
  };
}

/**
 * Spawn one hidden thread on the pinned judge model, wait for it, and read
 * its verdict. The thread runs in a personal workspace: a judge must never
 * be able to touch the tree it is grading.
 */
export async function runJudge(input: JudgeInput): Promise<JudgeVerdict> {
  const evidence =
    input.inlineEvidence ?? judgeEvidence(input.artifactsDir, input.evidenceBudget);
  const [providerId, ...modelParts] = input.judge.model.split("/");
  const model = modelParts.join("/");
  if (providerId === undefined || model === "") {
    return { verdict: "fail", reason: `judge model must be "<provider>/<model>", got "${input.judge.model}"` };
  }
  const thread = await input.bb.sdk.threads.spawn({
    projectId: input.projectId,
    title: `eval judge ${Date.now()}`,
    visibility: "hidden",
    providerId,
    model,
    environment: { type: "host", workspace: { type: "personal" } },
    prompt: judgePrompt(input.judge.rubric, evidence),
  });
  await input.bb.sdk.threads.wait({
    threadId: thread.id,
    status: "idle",
    timeoutMs: input.timeoutMs ?? 600_000,
  });
  const output = await input.bb.sdk.threads.output({ threadId: thread.id });
  return parseJudgeVerdict(output.output);
}

// ---------------------------------------------------------------------------
// judge-validate
// ---------------------------------------------------------------------------

export const DEFAULT_JUDGE_FIXTURES_DIR = "~/.agents/eval/judge-fixtures";

export interface JudgeFixture {
  name: string;
  /** What a correct judge must answer. */
  label: "pass" | "fail";
  rubric: string;
  evidence: string;
}

export interface JudgeValidateReport {
  /** True positives over labelled passes. */
  tpr: number;
  /** True negatives over labelled fails. */
  tnr: number;
  /** Both rates at or above this make the judge trustworthy. */
  threshold: number;
  trusted: boolean;
  rows: ReadonlyArray<{ name: string; expected: string; got: string; correct: boolean }>;
}

export const JUDGE_TRUST_THRESHOLD = 0.9;

/** Load `*.json` fixtures. A malformed fixture is skipped with its name. */
export function loadJudgeFixtures(dir: string): { fixtures: JudgeFixture[]; skipped: string[] } {
  const root = expandHome(dir);
  const fixtures: JudgeFixture[] = [];
  const skipped: string[] = [];
  let names: string[];
  try {
    names = readdirSync(root).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return { fixtures, skipped };
  }
  for (const name of names) {
    try {
      const raw = JSON.parse(readFileSync(join(root, name), "utf8")) as Partial<JudgeFixture>;
      if (
        (raw.label !== "pass" && raw.label !== "fail") ||
        typeof raw.rubric !== "string" ||
        typeof raw.evidence !== "string"
      ) {
        skipped.push(name);
        continue;
      }
      fixtures.push({
        name: name.replace(/\.json$/, ""),
        label: raw.label,
        rubric: raw.rubric,
        evidence: raw.evidence,
      });
    } catch {
      skipped.push(name);
    }
  }
  return { fixtures, skipped };
}

export function scoreJudge(
  rows: ReadonlyArray<{ name: string; expected: "pass" | "fail"; got: "pass" | "fail" }>,
  threshold = JUDGE_TRUST_THRESHOLD,
): JudgeValidateReport {
  const positives = rows.filter((row) => row.expected === "pass");
  const negatives = rows.filter((row) => row.expected === "fail");
  // An empty class scores 0 rather than 1: a judge nobody tested on failures
  // has not earned the benefit of the doubt.
  const rate = (subset: typeof positives) =>
    subset.length === 0
      ? 0
      : subset.filter((row) => row.got === row.expected).length / subset.length;
  const tpr = rate(positives);
  const tnr = rate(negatives);
  return {
    tpr,
    tnr,
    threshold,
    trusted: tpr >= threshold && tnr >= threshold,
    rows: rows.map((row) => ({ ...row, correct: row.got === row.expected })),
  };
}
