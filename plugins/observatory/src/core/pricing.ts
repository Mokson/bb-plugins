// What one logged turn cost, in dollars.
//
// Pure arithmetic over a resolved rate, so the whole precedence ladder is
// testable without a catalog fetch or a database. The ladder, in order:
//
//   logged      the provider told us (Pi, OpenCode). Nothing beats a figure
//               the biller produced; a catalog estimate over the top of it is
//               strictly worse information.
//   catalog     a resolved models.dev rate, priced per token class.
//   unpriceable the model id is a placeholder that never had a price
//               (`<synthetic>`, or a bare tier name like "opus" that a harness
//               writes when it does not know the concrete model).
//   unknown     a real model id nothing could resolve. Cost is NULL, and it
//               stays null: `$0.00` reads as free, `n/a` reads as unmeasured,
//               and only one of those is true.
//
// The cache rule is the subtle one. When a provider reports a single
// `cachedInputTokens` without splitting read from write, those tokens are
// priced at the CACHE-READ rate (reads dominate by an order of magnitude in
// every real trace) but `cacheSavingsUsd` comes back NULL, because a savings
// number is a claim about how much was written versus re-read and that split
// is exactly what is missing. Guessing a write share here would put a made-up
// number on the cost page under a confident heading.
import { resolveModel, type PricingCatalog } from "./catalog.js";

export type CostSource = "logged" | "catalog" | "unpriceable" | "unknown";
export type PricingStatus =
  | "exact"
  | "alias"
  | "prefix"
  | "logged"
  // PRODUCT invariant 12 names this state, and no row ever carried it: the
  // placeholder branch below reported "unknown", collapsing "this id can
  // never have a price" into "nothing resolved this id, try again later".
  | "unpriceable"
  | "unknown";

export interface PriceTurnInput {
  provider: string;
  model: string | null;
  inputTokens: number;
  /** Null when the provider did not split read from write. */
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** The unsplit cached total, as bb's usage event reports it. */
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  loggedCostUsd: number | null;
}

export interface PriceTurnResult {
  costUsd: number | null;
  costSource: CostSource;
  pricingStatus: PricingStatus;
  cacheSavingsUsd: number | null;
}

/**
 * Model ids that are real in a log but never had a price.
 *
 * The bare tier names are here because several harnesses write "opus" or
 * "sonnet" when the concrete id is not in scope. Pricing those against the
 * newest model of that tier would be a guess dressed as a measurement.
 */
export const UNPRICEABLE_MODELS = new Set([
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);

function bareName(model: string): string {
  const normalized = model.trim().toLowerCase();
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

export function isUnpriceableModel(model: string | null): boolean {
  if (!model || !model.trim()) return false;
  return UNPRICEABLE_MODELS.has(bareName(model));
}

function nonNegative(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/** Rates are published per million tokens. */
const PER_MILLION = 1_000_000;

export function priceTurn(
  input: PriceTurnInput,
  catalog: PricingCatalog,
): PriceTurnResult {
  const logged = input.loggedCostUsd;
  const hasLogged =
    typeof logged === "number" && Number.isFinite(logged) && logged >= 0;

  // The catalog is resolved even when a logged cost wins, because
  // `cacheSavingsUsd` is a counterfactual ("what the reads would have cost
  // uncached") that no provider reports.
  const resolved = isUnpriceableModel(input.model)
    ? null
    : resolveModel(catalog, input.provider, input.model);
  const price = resolved?.price ?? null;

  const cacheRead = input.cacheReadTokens;
  const cacheWrite = input.cacheWriteTokens;
  const splitKnown = cacheRead !== null && cacheWrite !== null;
  // Read tokens are taken from whichever field ACTUALLY carries them, one
  // field at a time. Codex is the case that forces this: it reports
  // `cacheRead` and leaves `cacheWrite` null, so an all-or-nothing split test
  // would throw its read count away and fall back to `cachedInputTokens`,
  // which Codex never sets. Every Codex bill then collapsed to the uncached
  // input alone. A missing WRITE count is still not evidence of a zero write,
  // but it costs nothing here: `price.cacheWrite * 0` is the same figure the
  // old branch produced, and the honesty is enforced on `cacheSavingsUsd`
  // below, which stays null until the full split is known.
  const readTokens =
    cacheRead !== null
      ? nonNegative(cacheRead)
      : nonNegative(input.cachedInputTokens);
  const writeTokens = nonNegative(cacheWrite);

  let cacheSavingsUsd: number | null = null;
  if (price && splitKnown) {
    const saved = (price.input - price.cacheRead) * readTokens;
    cacheSavingsUsd = saved > 0 ? saved / PER_MILLION : 0;
  }

  if (hasLogged) {
    return {
      costUsd: logged,
      costSource: "logged",
      pricingStatus: "logged",
      cacheSavingsUsd,
    };
  }

  if (isUnpriceableModel(input.model)) {
    return {
      costUsd: null,
      costSource: "unpriceable",
      pricingStatus: "unpriceable",
      cacheSavingsUsd: null,
    };
  }

  if (!price || !resolved) {
    return {
      costUsd: null,
      costSource: "unknown",
      pricingStatus: "unknown",
      cacheSavingsUsd: null,
    };
  }

  const costUsd =
    (nonNegative(input.inputTokens) * price.input +
      readTokens * price.cacheRead +
      writeTokens * price.cacheWrite +
      (nonNegative(input.outputTokens) + nonNegative(input.reasoningTokens)) *
        price.output) /
    PER_MILLION;

  return {
    costUsd: Number.isFinite(costUsd) && costUsd >= 0 ? costUsd : null,
    costSource: Number.isFinite(costUsd) && costUsd >= 0 ? "catalog" : "unknown",
    pricingStatus: resolved.status,
    cacheSavingsUsd,
  };
}
