// The baseline seam. Part 2 implements it.
//
// PRODUCT.md invariant 5: an eval baseline changes ONLY through
// `bb observatory eval baseline promote <run>`. No run, gate, or cron writes
// `eval_baseline`. That is why promotion lives in its own module with an
// explicit run id argument rather than as a flag on the runner.
import type { EvalStore } from "./store.js";
import { NotImplementedError } from "./runner.js";

export interface PromoteInput {
  store: EvalStore;
  runId: string;
  /** Restrict promotion to these case names; absent promotes every result. */
  cases?: readonly string[];
  promotedAt: string;
}

export interface PromoteReport {
  /** Case names whose baseline moved. */
  promoted: readonly string[];
  /** Case names skipped, each with why. */
  skipped: ReadonlyArray<{ case: string; reason: string }>;
}

export function promoteBaseline(_input: PromoteInput): PromoteReport {
  throw new NotImplementedError("eval baseline promotion");
}
