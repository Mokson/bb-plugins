// The eval case schema and its loader.
//
// PRODUCT.md invariant 29: "An eval case is a YAML file with structured
// assertion keys. There is no expression language. An unknown key fails the
// case." Every object below is `.strict()` for that reason, and a load failure
// names the PATH of the offending key so a typo is a one-line fix rather than
// a hunt. There is no partial load: a case is valid or it is refused.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { YamlError, parseYaml } from "./yaml.js";

const nonEmpty = z.string().min(1);

/** A provider/model/effort triple, as `threads.spawn` wants it. */
export const seatModelSchema = z
  .object({
    provider: nonEmpty,
    model: nonEmpty,
    effort: nonEmpty,
  })
  .strict();

export const fixtureSchema = z
  .object({
    /** The bb project the hidden thread is spawned into. */
    project: nonEmpty,
    /** Absolute path to the fixture git repo the worktree is cut from. */
    repo: nonEmpty,
    base_branch: nonEmpty,
    /** Pinned commit. A branch name here would make the case drift. */
    sha: nonEmpty,
    /** Patches applied to the worktree, relative to `repo`. */
    dirty: z.array(nonEmpty).default([]),
    env_files: z.array(nonEmpty).default([]),
  })
  .strict();

export const invocationSchema = z
  .object({
    text: nonEmpty,
    route: nonEmpty.optional(),
    mode: nonEmpty.optional(),
    seat_vendors: z.record(nonEmpty, nonEmpty).optional(),
  })
  .strict();

export const harnessSchema = z
  .object({
    /** Pins the skill stack. Absent means "whatever HEAD of ~/.agents is". */
    stack_sha: nonEmpty.optional(),
    // The only accepted value today. A case must never reach a real tracker:
    // an eval that files issues is a side effect, not a measurement.
    tracker: z.literal("none"),
    agents_dir: nonEmpty,
    qa_tooling: nonEmpty.optional(),
    tier_models: z.record(nonEmpty, seatModelSchema),
    orchestrator: seatModelSchema,
    checkpoint_budgets: z.record(nonEmpty, z.number().int().positive()).optional(),
  })
  .strict();

export const limitsSchema = z
  .object({
    timeout_ms: z.number().int().positive(),
    cost_ceiling_usd: z.number().positive(),
    max_total_tokens: z.number().int().positive(),
  })
  .strict();

/** One canned reply to an agent question, so a case never blocks on a human. */
export const answerSchema = z
  .object({
    match: z
      .object({
        kind: nonEmpty.optional(),
        text_regex: nonEmpty.optional(),
      })
      .strict(),
    respond: nonEmpty,
    /** Present on the fallback rule. `max_uses` bounds an answer loop. */
    default: z
      .object({ max_uses: z.number().int().positive() })
      .strict()
      .optional(),
  })
  .strict();

export const ledgerAssertSchema = z
  .object({
    exists: z.boolean(),
    sections_present: z.array(nonEmpty).default([]),
    gates_count_min: z.number().int().nonnegative().optional(),
    done_when_status: nonEmpty.optional(),
    nudges_max: z.number().int().nonnegative().optional(),
  })
  .strict();

export const artifactsAssertSchema = z
  .object({
    exists: z.array(nonEmpty).default([]),
    absent: z.array(nonEmpty).default([]),
    size_ceilings: z.record(nonEmpty, z.number().int().positive()).default({}),
  })
  .strict();

export const exitCodeAssertSchema = z
  .object({ cmd: nonEmpty, expect: z.number().int() })
  .strict();

export const traceAssertSchema = z
  .object({
    max_turns: z.number().int().positive(),
    max_tool_calls: z.number().int().positive(),
    max_tokens: z.number().int().positive(),
    max_cost_usd: z.number().positive(),
    max_wall_ms: z.number().int().positive(),
    no_provider_errors: z.boolean(),
    subthreads_min: z.number().int().nonnegative().optional(),
  })
  .strict();

export const outputAssertSchema = z
  .object({
    contains: z.array(nonEmpty).default([]),
    not_contains: z.array(nonEmpty).default([]),
    matches: z.array(nonEmpty).default([]),
  })
  .strict();

export const judgeAssertSchema = z
  .object({ rubric: nonEmpty, model: nonEmpty })
  .strict();

export const assertSchema = z
  .object({
    ledger: ledgerAssertSchema.optional(),
    artifacts: artifactsAssertSchema.optional(),
    exit_codes: z.array(exitCodeAssertSchema).optional(),
    trace: traceAssertSchema.optional(),
    output: outputAssertSchema.optional(),
    judge: judgeAssertSchema.optional(),
    /** The gc route must not rewrite the skills tree during a dry evaluation. */
    skills_tree_unchanged: z.boolean().optional(),
  })
  .strict();

export const caseSchema = z
  .object({
    name: nonEmpty,
    tags: z.array(nonEmpty).default([]),
    /** Repeats of the same case; variance is the point, so 1 is the floor. */
    trials: z.number().int().positive().default(1),
    retries: z.number().int().nonnegative().default(0),
    /**
     * Leave the worktree on disk when a trial fails. Off by default: a suite
     * that keeps every red tree fills a disk, and harvest already saved the
     * evidence. Turn it on for the one case being debugged.
     */
    keep_on_fail: z.boolean().default(false),
    fixture: fixtureSchema,
    invocation: invocationSchema,
    harness: harnessSchema,
    limits: limitsSchema,
    answers: z.array(answerSchema).default([]),
    assert: assertSchema,
  })
  .strict();

export type SeatModel = z.output<typeof seatModelSchema>;
export type EvalCase = z.output<typeof caseSchema>;
export type EvalAssert = z.output<typeof assertSchema>;

/** A file that was read, whether or not it parsed. */
export interface LoadedCase {
  /** Absolute path of the YAML file. */
  path: string;
  /** The case's declared name, or the file stem when it could not be read. */
  name: string;
  tags: readonly string[];
  value: EvalCase | null;
  /** Null exactly when `value` is set. */
  error: string | null;
}

/** Expand a leading `~` so a setting can stay readable. */
export function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

/**
 * Render a zod failure as one line per issue, each led by its path. An
 * unrecognized key names the key itself, since that is the whole diagnosis.
 */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
      if (issue.code === "unrecognized_keys") {
        const keys = issue.keys.map((key) => `${path}.${key}`).join(", ");
        return `unknown key: ${keys}`;
      }
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/** Parse one case file. Never throws: a bad case is data, not a crash. */
export function loadCaseFile(path: string): LoadedCase {
  const stem = basename(path).replace(/\.ya?ml$/, "");
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (error) {
    const message =
      error instanceof YamlError
        ? `yaml ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return { path, name: stem, tags: [], value: null, error: message };
  }
  const parsed = caseSchema.safeParse(raw);
  if (!parsed.success) {
    return { path, name: stem, tags: [], value: null, error: formatIssues(parsed.error) };
  }
  // The name is the run's key into `eval_case_result`, so a case whose name
  // disagrees with its filename would make `eval show` unreadable.
  if (parsed.data.name !== stem) {
    return {
      path,
      name: stem,
      tags: [],
      value: null,
      error: `name "${parsed.data.name}" does not match the file name "${stem}"`,
    };
  }
  return {
    path,
    name: parsed.data.name,
    tags: parsed.data.tags,
    value: parsed.data,
    error: null,
  };
}

/** Every `*.yaml` in `dir`, sorted by name. A missing directory yields none. */
export function loadCasesDir(dir: string): LoadedCase[] {
  const root = expandHome(dir);
  let names: string[];
  try {
    if (!statSync(root).isDirectory()) return [];
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => loadCaseFile(join(root, name)));
}

/** Narrow a case list by `--tag` and `--case`, both optional and ANDed. */
export function selectCases(
  cases: readonly LoadedCase[],
  filter: { tag?: string; case?: string },
): LoadedCase[] {
  return cases.filter((entry) => {
    if (filter.case !== undefined && entry.name !== filter.case) return false;
    if (filter.tag !== undefined && !entry.tags.includes(filter.tag)) return false;
    return true;
  });
}
