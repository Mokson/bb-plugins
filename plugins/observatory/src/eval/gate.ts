// The gate seam. Part 2 implements it; the signature is fixed here so the
// run row's `gate` column and the CLI already agree on the vocabulary.
//
// `--gate` turns a run into a pass/fail verdict on the current skill stack
// (PRODUCT.md done-check c12). A gate never mutates a baseline: PRODUCT.md
// invariant 5 reserves that for `eval baseline promote`.
import type { EvalCaseResultRow, EvalRunRow } from "./store.js";
import type { EvalBaselineRow } from "./store.js";
import { NotImplementedError } from "./runner.js";

export type GateVerdict = "pass" | "fail" | "not-run";

export interface GateInput {
  run: EvalRunRow;
  results: readonly EvalCaseResultRow[];
  /** Keyed by case name. A case with no baseline cannot regress, only fail. */
  baselines: ReadonlyMap<string, EvalBaselineRow>;
}

export interface GateReport {
  verdict: GateVerdict;
  /** One line per case, whether it passed and what it regressed against. */
  lines: readonly string[];
}

export function evaluateGate(_input: GateInput): GateReport {
  throw new NotImplementedError("the eval gate");
}
