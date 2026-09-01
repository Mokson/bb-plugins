// The live runner seam. Part 1 provisions and plans; part 2 spawns.
//
// The signature is here, and only the signature, so the dry-run path and the
// store already speak the shape the runner will fill. `runCase` throws rather
// than returning a fabricated pass: an eval that reports success without
// running is the single worst failure this module can have.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { EvalCase } from "./cases.js";
import type { SpawnPlan } from "./dryrun.js";

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} arrives in part 2`);
    this.name = "NotImplementedError";
  }
}

export interface RunCaseInput {
  bb: BbPluginApi;
  runId: string;
  case: EvalCase;
  trial: number;
  /** The provisioned worktree the case runs against. */
  worktree: string;
  /** Exactly what part 1's dry run printed, so the two cannot drift. */
  spawn: SpawnPlan;
}

export interface RunCaseResult {
  status: "pass" | "fail" | "error" | "timeout";
  threadId: string | null;
  artifactsDir: string | null;
  /** Assertion outcomes, one per declared assertion. */
  assertions: unknown;
  /** Turns, tool calls, tokens, cost, wall time. */
  metrics: unknown;
}

/** Spawn a hidden thread for one trial, answer its questions, and harvest. */
export function runCase(_input: RunCaseInput): Promise<RunCaseResult> {
  return Promise.reject(new NotImplementedError("the eval runner"));
}
