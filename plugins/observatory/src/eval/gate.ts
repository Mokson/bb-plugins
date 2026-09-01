// The gate: does this run say the skill stack is still good?
//
// The vocabulary is deliberately three-valued, because two of the three
// answers are useless if they are collapsed. A FAIL is a regression somebody
// must look at now. A WARN is a drift somebody should look at this week. And
// N/A — no baseline — is the honest answer to "did it get worse?" when there
// is nothing to compare against, so it exits 2 rather than pretending to be a
// pass on the first run of a new case.
//
// A gate NEVER mutates a baseline. PRODUCT.md invariant 5 reserves that for
// `eval baseline promote`, which is why nothing in this file takes a writable
// store.
import type { TreeMetrics } from "./metrics.js";
import type { EvalBaselineRow, EvalCaseResultRow, EvalRunRow } from "./store.js";

export type GateVerdict = "pass" | "warn" | "fail" | "not-run";

/** Drift a run may show against its baseline before it is worth a word. */
export const DRIFT = {
  tokens: 0.5,
  cost: 0.4,
  wall: 0.6,
} as const;

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

function parseMetrics(json: string | null): Partial<TreeMetrics> | null {
  if (json === null) return null;
  try {
    return JSON.parse(json) as Partial<TreeMetrics>;
  } catch {
    return null;
  }
}

/** A pass is a pass; anything else, including a missing status, is not. */
function passed(status: string | null): boolean {
  return status === "pass";
}

function drift(
  label: string,
  now: number | undefined,
  before: number | undefined,
  allowed: number,
): string | null {
  if (now === undefined || before === undefined || before <= 0) return null;
  const growth = (now - before) / before;
  return growth > allowed
    ? `${label} up ${Math.round(growth * 100)} percent over baseline`
    : null;
}

/**
 * Grade a run. Trials of the same case are folded first: a case passes only
 * when every trial passed, and a case that passed its baseline but now passes
 * only sometimes is the "new flaky" warning.
 */
export function evaluateGate(input: GateInput): GateReport {
  const byCase = new Map<string, EvalCaseResultRow[]>();
  for (const row of input.results) {
    const list = byCase.get(row.case) ?? [];
    list.push(row);
    byCase.set(row.case, list);
  }
  // The run's frozen case list is the source of truth: a case selected at run
  // time that produced no row at all is a failure, not an absence.
  const names = (() => {
    try {
      const parsed = JSON.parse(input.run.cases_json ?? "[]") as unknown;
      return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
    } catch {
      return [...byCase.keys()];
    }
  })();

  const lines: string[] = [];
  let fail = false;
  let warn = false;
  let missingBaseline = false;

  for (const name of names.length === 0 ? [...byCase.keys()] : names) {
    const trials = byCase.get(name) ?? [];
    if (trials.length === 0) {
      lines.push(`FAIL ${name}: the run recorded no result`);
      fail = true;
      continue;
    }
    const allPassed = trials.every((row) => passed(row.status));
    const anyPassed = trials.some((row) => passed(row.status));
    const baseline = input.baselines.get(name);

    if (!allPassed && !anyPassed) {
      lines.push(
        `FAIL ${name}: ${trials.filter((row) => !passed(row.status)).length}/${
          trials.length
        } trials failed structurally`,
      );
      fail = true;
      continue;
    }

    if (baseline === undefined) {
      lines.push(`N/A  ${name}: passed, but no baseline to compare against`);
      missingBaseline = true;
      continue;
    }

    const before = parseMetrics(baseline.metrics_json) ?? {};
    // The worst trial is the one a budget has to survive.
    const worst = trials
      .map((row) => parseMetrics(row.metrics_json) ?? {})
      .reduce<Partial<TreeMetrics>>(
        (acc, entry) => ({
          tokens: Math.max(acc.tokens ?? 0, entry.tokens ?? 0),
          costUsd: Math.max(acc.costUsd ?? 0, entry.costUsd ?? 0),
          wallMs: Math.max(acc.wallMs ?? 0, entry.wallMs ?? 0),
        }),
        {},
      );

    if (!allPassed) {
      // Baseline says this case passes; this run says sometimes. That is the
      // flake, and a flake is a warning rather than a stop because one red
      // trial out of three does not prove the stack regressed.
      lines.push(
        `WARN ${name}: newly flaky, ${trials.filter((row) => passed(row.status)).length}/${
          trials.length
        } trials passed`,
      );
      warn = true;
      continue;
    }

    const drifts = [
      drift("tokens", worst.tokens, before.tokens, DRIFT.tokens),
      drift("cost", worst.costUsd, before.costUsd, DRIFT.cost),
      drift("wall", worst.wallMs, before.wallMs, DRIFT.wall),
    ].filter((entry): entry is string => entry !== null);

    if (drifts.length > 0) {
      lines.push(`WARN ${name}: ${drifts.join(", ")}`);
      warn = true;
      continue;
    }
    lines.push(`pass ${name}`);
  }

  if (lines.length === 0) return { verdict: "not-run", lines: ["no cases were graded"] };
  const verdict: GateVerdict = fail
    ? "fail"
    : missingBaseline && !warn
      ? "not-run"
      : warn
        ? "warn"
        : "pass";
  return { verdict, lines };
}

/**
 * The process exit code. `--strict` is the only thing that turns drift into a
 * stop, so a nightly can warn loudly while CI stays green until somebody
 * decides the drift matters.
 */
export function gateExitCode(verdict: GateVerdict, strict: boolean): number {
  if (verdict === "fail") return 1;
  if (verdict === "not-run") return 2;
  if (verdict === "warn") return strict ? 1 : 0;
  return 0;
}
