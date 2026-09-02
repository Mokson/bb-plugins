// One trial: spawn a hidden thread, answer its questions, hold it to its
// budget, harvest it, and assert against what it left behind.
//
// Three rules shape this file.
//
// 1. Exactly once. The thread's title carries the run id, the case and the
//    trial, and the runner LOOKS FOR that title before it spawns. A retried
//    CLI invocation rejoins the thread it already paid for rather than
//    starting a second one.
// 2. It stops only what it spawned. `stopOwnedThread` refuses any thread id
//    that is not recorded in this plugin's own `eval_case_result`, and the
//    thread id is written there the moment the spawn returns — before the
//    first budget check — so ownership survives a process restart. This is
//    the ONLY place in the plugin that calls `threads.stop`.
// 3. An unanswered question is a failure, not a wait. A case that blocks on a
//    human is a case that measures nothing.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Database } from "better-sqlite3";
import type { AssertionReport, CommandRunner } from "./assert.js";
import { runJudge, runStructuralAssertions } from "./assert.js";
import type { EvalCase } from "./cases.js";
import type { GitRunner, SpawnPlan } from "./dryrun.js";
import type { HarvestReport } from "./harvest.js";
import { harvestCase, teardownWorktree } from "./harvest.js";
import type { TreeMetrics } from "./metrics.js";
import { EMPTY_METRICS, treeMetrics } from "./metrics.js";
import type { EvalStore } from "./store.js";

/** Why a trial ended. `budget` and `unanswered-gate` are the two kills. */
export type FailReason =
  | "assertions"
  | "budget"
  | "unanswered-gate"
  | "cancelled"
  | "spawn-failed"
  | null;

export interface RunCaseResult {
  status: "pass" | "fail" | "error" | "timeout";
  threadId: string | null;
  artifactsDir: string | null;
  assertions: AssertionReport | null;
  metrics: TreeMetrics;
  failReason: FailReason;
  /** True when the tree was kept on disk for inspection. */
  worktreeKept: boolean;
  /** Operator-facing detail; the CLI prints it under the case line. */
  detail: string;
}

export interface RunCaseInput {
  bb: BbPluginApi;
  db: Database;
  store: EvalStore;
  runId: string;
  case: EvalCase;
  trial: number;
  /** The provisioned worktree the case runs against. */
  worktree: string;
  /** Exactly what part 1's dry run printed, so the two cannot drift. */
  spawn: SpawnPlan;
  artifactsRoot: string;
  stackShaAtStart: string | null;
  checkLedgerScript?: string;
  /** Milliseconds between budget sweeps. `events.wait` is the sleep. */
  pollMs?: number;
  now?: () => number;
  git?: GitRunner;
  run?: CommandRunner;
}

export const DEFAULT_POLL_MS = 5_000;

/** The event the runner blocks on between sweeps; the wait is bounded anyway. */
export const WAKE_EVENT = "thread/turn/completed";

export class ForeignThreadError extends Error {
  constructor(threadId: string) {
    super(`refusing to stop ${threadId}: this plugin did not spawn it`);
    this.name = "ForeignThreadError";
  }
}

/**
 * The single stop in the plugin. Ownership is read from the store rather than
 * from process memory, so an `eval cancel` in a later process is still bound
 * by it and a bug that passes the wrong id throws instead of killing a
 * person's work. PRODUCT.md invariant 1.
 */
export async function stopOwnedThread(
  bb: BbPluginApi,
  store: EvalStore,
  threadId: string,
): Promise<void> {
  if (!store.ownsThread(threadId)) throw new ForeignThreadError(threadId);
  await bb.sdk.threads.stop({ threadId });
}

/** One question of a provider's `user_question` interaction. */
interface PendingQuestion {
  id: string;
  /** What the agent actually asked. Often the only text the interaction has. */
  prompt?: string;
  allowFreeText: boolean;
  options?: ReadonlyArray<{ label: string; value: string }>;
}

interface PendingLike {
  id: string;
  status: string;
  payload?: {
    kind?: string;
    title?: string;
    data?: unknown;
    questions?: readonly PendingQuestion[];
  };
}

/** Everything a rule's `text_regex` is tested against. */
export function interactionText(interaction: PendingLike): string {
  const payload = interaction.payload ?? {};
  const data = payload.data === undefined ? "" : JSON.stringify(payload.data);
  // The question prompts, not just the title: a provider `user_question` puts
  // what it asked in `questions[].prompt` and leaves the title generic, so a
  // rule matching on the question's own words used to see nothing.
  const prompts = (payload.questions ?? [])
    .map((question) => question.prompt ?? "")
    .filter((prompt) => prompt !== "")
    .join("\n");
  return `${payload.title ?? ""}\n${prompts}\n${data}`;
}

export function interactionKind(interaction: PendingLike): string {
  return interaction.payload?.kind ?? "";
}

/** A rule and how many of its `default.max_uses` remain. */
interface AnswerRule {
  respond: string;
  kind?: string;
  textRegex?: string;
  remaining: number | null;
}

export function buildAnswerRules(value: EvalCase): AnswerRule[] {
  return value.answers.map((entry) => ({
    respond: entry.respond,
    ...(entry.match.kind === undefined ? {} : { kind: entry.match.kind }),
    ...(entry.match.text_regex === undefined ? {} : { textRegex: entry.match.text_regex }),
    remaining: entry.default?.max_uses ?? null,
  }));
}

/**
 * The FIRST rule that matches wins, and an exhausted `default` rule matches
 * nothing. A rule with an empty `match` is the catch-all, which is why
 * `max_uses` matters: without it a stuck agent and a catch-all answer make a
 * free loop that only the cost ceiling ends.
 */
export function matchAnswer(rules: AnswerRule[], interaction: PendingLike): AnswerRule | null {
  const kind = interactionKind(interaction);
  const text = interactionText(interaction);
  for (const rule of rules) {
    if (rule.remaining !== null && rule.remaining <= 0) continue;
    if (rule.kind !== undefined && rule.kind !== kind) continue;
    if (rule.textRegex !== undefined) {
      let matched: boolean;
      try {
        matched = new RegExp(rule.textRegex, "i").test(text);
      } catch {
        // A rule with a broken regex must not silently swallow questions.
        continue;
      }
      if (!matched) continue;
    }
    return rule;
  }
  return null;
}

/**
 * The option a rule's text names, or the first one — bb's own convention puts
 * the recommended option first, which is what "proceed with your recommended
 * option" asks for. A question with no options takes the text itself.
 */
export function questionAnswer(
  question: PendingQuestion,
  respond: string,
): { selected: string[]; freeText?: string } {
  const options = question.options ?? [];
  const text = respond.toLowerCase();
  const named = options.find(
    (option) =>
      text.includes(option.value.toLowerCase()) ||
      text.includes(option.label.toLowerCase()),
  );
  const chosen = named ?? options[0];
  if (chosen === undefined) return { selected: [], freeText: respond };
  return { selected: [chosen.value] };
}

/**
 * Deliver one rule's answer in the shape the interaction's own kind takes.
 * A provider question and a permission approval are RESOLVED: `respond` is
 * the plugin-form path, and bb rejects it for a provider interaction with
 * "Plugin interaction expected". A plugin's own form still takes the raw
 * value, since only the plugin that raised it knows what shape it wants.
 */
async function answerInteraction(
  bb: BbPluginApi,
  threadId: string,
  interaction: PendingLike,
  respond: string,
): Promise<void> {
  const target = { threadId, interactionId: interaction.id };
  switch (interactionKind(interaction)) {
    case "approval":
      await bb.sdk.threads.interactions.resolve({
        ...target,
        resolution: { decision: "allow_once", grantedPermissions: null },
      });
      return;
    case "user_question": {
      const answers: Record<string, { selected: string[]; freeText?: string }> = {};
      for (const question of interaction.payload?.questions ?? []) {
        answers[question.id] = questionAnswer(question, respond);
      }
      await bb.sdk.threads.interactions.resolve({
        ...target,
        resolution: { kind: "user_answer", answers },
      });
      return;
    }
    default:
      await bb.sdk.threads.interactions.respond({ ...target, value: respond });
  }
}

export interface BudgetBreach {
  kind: "cost" | "tokens" | "wall";
  detail: string;
}

export function budgetBreach(value: EvalCase, metrics: TreeMetrics): BudgetBreach | null {
  const { limits } = value;
  if (metrics.costUsd > limits.cost_ceiling_usd) {
    return {
      kind: "cost",
      detail: `cost ${metrics.costUsd.toFixed(2)} usd over the ${limits.cost_ceiling_usd} ceiling`,
    };
  }
  if (metrics.tokens > limits.max_total_tokens) {
    return {
      kind: "tokens",
      detail: `${metrics.tokens} tokens over the ${limits.max_total_tokens} ceiling`,
    };
  }
  if (metrics.wallMs > limits.timeout_ms) {
    return {
      kind: "wall",
      detail: `${metrics.wallMs}ms over the ${limits.timeout_ms}ms timeout`,
    };
  }
  return null;
}

async function findExistingThread(bb: BbPluginApi, plan: SpawnPlan): Promise<string | null> {
  const threads = await bb.sdk.threads.list({
    projectId: plan.projectId,
    includeHidden: true,
    limit: 200,
  });
  return threads.find((thread) => thread.title === plan.title)?.id ?? null;
}

/**
 * The machine that owns the project's checkout. A `host` environment carrying
 * an unmanaged path is refused unless the request names its host — only a
 * personal workspace may leave it out — and the worktree the runner cut lives
 * on exactly one machine, so the host is resolved from the project's own
 * default source rather than left to a server-side guess.
 */
async function resolveHostId(bb: BbPluginApi, projectId: string): Promise<string> {
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  const project = projects.find((entry) => entry.id === projectId);
  if (!project) {
    throw new Error(`eval spawn: no project ${projectId} on this bb`);
  }
  const source =
    project.sources.find((entry) => entry.isDefault) ?? project.sources[0];
  if (!source) {
    throw new Error(`eval spawn: project ${projectId} has no source to spawn on`);
  }
  return source.hostId;
}

async function spawnThread(bb: BbPluginApi, plan: SpawnPlan): Promise<string> {
  const hostId = await resolveHostId(bb, plan.projectId);
  const thread = await bb.sdk.threads.spawn({
    projectId: plan.projectId,
    title: plan.title,
    visibility: "hidden",
    // The YAML strings are narrowed here and nowhere earlier: a case that
    // names a model bb does not know must fail at the spawn with bb's own
    // message, not at load with ours.
    providerId: plan.providerId,
    model: plan.model,
    reasoningLevel: plan.reasoningLevel as never,
    environment: {
      type: "host",
      hostId,
      workspace: { type: "unmanaged", path: plan.environment.workspace.path },
    },
    prompt: plan.prompt,
  });
  return thread.id;
}

/** Bounded sleep. `events.wait` returns early on a turn boundary. */
async function waitForActivity(
  bb: BbPluginApi,
  threadId: string,
  waitMs: number,
): Promise<void> {
  try {
    await bb.sdk.threads.events.wait({
      threadId,
      type: WAKE_EVENT,
      waitMs: String(Math.max(250, Math.floor(waitMs))),
    });
  } catch {
    // A failed wait is not a failed run; the next sweep re-reads status and
    // budget from the ledger regardless.
  }
}

/** Spawn a hidden thread for one trial, answer its questions, and harvest. */
export async function runCase(input: RunCaseInput): Promise<RunCaseResult> {
  const now = input.now ?? (() => Date.now());
  const started = now();
  const pollMs = input.pollMs ?? DEFAULT_POLL_MS;
  const rules = buildAnswerRules(input.case);
  const gitOption = input.git === undefined ? {} : { git: input.git };

  let threadId: string;
  try {
    // Exactly-once: the title IS the operation id, so a rejoin is a lookup.
    threadId =
      (await findExistingThread(input.bb, input.spawn)) ??
      (await spawnThread(input.bb, input.spawn));
    // Recorded before the first budget check, so the stop guard can see it.
    input.store.upsertCaseResult({
      run_id: input.runId,
      case: input.case.name,
      trial: input.trial,
      status: "running",
      assertions_json: null,
      metrics_json: null,
      thread_id: threadId,
      artifacts_dir: null,
    });
  } catch (error) {
    const removed = teardownWorktree({
      case: input.case,
      worktree: input.worktree,
      failed: true,
      ...gitOption,
    });
    return {
      status: "error",
      threadId: null,
      artifactsDir: null,
      assertions: null,
      metrics: EMPTY_METRICS,
      failReason: "spawn-failed",
      worktreeKept: !removed,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  let metrics = treeMetrics(input.db, threadId, 0);
  let killed: { reason: NonNullable<FailReason>; detail: string } | null = null;

  for (;;) {
    metrics = treeMetrics(input.db, threadId, now() - started);

    // A cancel from another process moves the run row; honour it before spend.
    if (input.store.run(input.runId)?.status === "cancelled") {
      killed = { reason: "cancelled", detail: "run cancelled" };
      await stopOwnedThread(input.bb, input.store, threadId);
      break;
    }

    const breach = budgetBreach(input.case, metrics);
    if (breach !== null) {
      killed = { reason: "budget", detail: breach.detail };
      await stopOwnedThread(input.bb, input.store, threadId);
      break;
    }

    const pending = (await input.bb.sdk.threads.interactions.list({
      threadId,
    })) as unknown as PendingLike[];
    for (const interaction of pending) {
      if (interaction.status !== "pending") continue;
      const label = interaction.payload?.title ?? interaction.id;
      const rule = matchAnswer(rules, interaction);
      if (rule === null) {
        killed = {
          reason: "unanswered-gate",
          detail: `no answers[] rule matched "${label}" (kind ${
            interactionKind(interaction) || "unknown"
          })`,
        };
        break;
      }
      try {
        await answerInteraction(input.bb, threadId, interaction, rule.respond);
      } catch (error) {
        killed = {
          reason: "unanswered-gate",
          detail: `could not answer "${label}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
        break;
      }
      if (rule.remaining !== null) rule.remaining -= 1;
    }
    if (killed !== null) {
      await stopOwnedThread(input.bb, input.store, threadId);
      break;
    }

    const thread = await input.bb.sdk.threads.get({ threadId });
    if (thread.status === "idle" || thread.status === "error") break;

    const remaining = input.case.limits.timeout_ms - (now() - started);
    if (remaining <= 0) continue;
    await waitForActivity(input.bb, threadId, Math.min(pollMs, remaining));
  }

  metrics = treeMetrics(input.db, threadId, now() - started);

  // Harvest ALWAYS, including after a kill: a budget breach is exactly when
  // the partial evidence is worth the most.
  let harvest: HarvestReport;
  try {
    harvest = harvestCase({
      case: input.case,
      worktree: input.worktree,
      artifactsRoot: input.artifactsRoot,
      runId: input.runId,
      trial: input.trial,
      ...gitOption,
    });
  } catch (error) {
    harvest = {
      dir: input.worktree,
      runFolders: [],
      ledgerFound: false,
      retroFiles: 0,
      diffBytes: 0,
      notes: [`harvest failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  let output: string | null = null;
  try {
    output = (await input.bb.sdk.threads.output({ threadId })).output;
  } catch {
    output = null;
  }

  const assertions = runStructuralAssertions({
    case: input.case,
    worktree: input.worktree,
    harvest,
    metrics,
    output,
    stackShaAtStart: input.stackShaAtStart,
    ...(input.checkLedgerScript === undefined
      ? {}
      : { checkLedgerScript: input.checkLedgerScript }),
    ...(input.run === undefined ? {} : { run: input.run }),
  });

  // The judge runs ONLY after the structural keys agree. Asking a model
  // whether a run was good, when the ledger is missing and the tests are red,
  // buys an expensive opinion about nothing.
  const outcomes = [...assertions.outcomes];
  const judgeSpec = input.case.assert.judge;
  if (judgeSpec !== undefined && assertions.pass && killed === null) {
    try {
      const verdict = await runJudge({
        bb: input.bb,
        projectId: input.spawn.projectId,
        judge: judgeSpec,
        artifactsDir: harvest.dir,
      });
      outcomes.push({
        key: "judge",
        pass: verdict.verdict === "pass",
        detail: verdict.reason,
      });
    } catch (error) {
      outcomes.push({
        key: "judge",
        pass: false,
        detail: `the judge could not run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }
  const graded: AssertionReport = {
    pass: outcomes.every((entry) => entry.pass),
    outcomes,
  };

  const failed = killed !== null || !graded.pass;
  const removed = teardownWorktree({
    case: input.case,
    worktree: input.worktree,
    failed,
    ...gitOption,
  });

  const status: RunCaseResult["status"] =
    killed?.reason === "budget" && metrics.wallMs > input.case.limits.timeout_ms
      ? "timeout"
      : failed
        ? "fail"
        : "pass";

  return {
    status,
    threadId,
    artifactsDir: harvest.dir,
    assertions: graded,
    metrics,
    failReason: killed?.reason ?? (graded.pass ? null : "assertions"),
    worktreeKept: !removed,
    detail: killed?.detail ?? harvest.notes.join("; "),
  };
}
