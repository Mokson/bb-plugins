// The pieces every spend surface shares: the four hero numbers, the table
// chrome, and the one frame that decides what a page shows before its data
// arrives.
//
// Density contract (PRODUCT invariant 34): sizes 11, 13, 16, and 24 for at
// most four hero numbers; weights 400 and 600; 24px rows; hairlines, never
// boxes; numerics right-aligned with tabular figures and the unit in the
// header. Nothing here carries colour as meaning, so the same markup reads the
// same in either theme and in a screenshot.
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ESTIMATE_MARK, formatUsd } from "@/lib/format";
import { ABSENT_MESSAGE, type SpendQuery } from "@/lib/spend-rpc";
import type { SpendTotals } from "../../spend/contract.js";

/** A section heading. 16px, the only size above body on a page. */
export function Heading({ children }: { children: ReactNode }) {
  return <h2 className="text-[16px] font-semibold">{children}</h2>;
}

/** One 11px label above a 24px number. Never more than four in a row. */
export function Hero({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-[24px] font-semibold tabular-nums leading-none">
        {value}
      </span>
    </div>
  );
}

/**
 * The four hero numbers, plus the unpriced-model line when there is one.
 *
 * Cache saved and cache write stay separate rather than netting into one
 * "cache" figure: netting them hides which side moved, and the two have
 * opposite meanings for a reader deciding whether to change a prompt.
 */
export function Heroes({
  totals,
  onReviewUnpriced,
}: {
  totals: SpendTotals;
  onReviewUnpriced?: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-4 gap-6">
        <Hero label="spend usd" value={formatUsd(totals.spendUsd)} />
        <Hero label="cache saved usd" value={formatUsd(totals.cacheSavedUsd)} />
        <Hero label="cache write usd" value={formatUsd(totals.cacheWriteUsd)} />
        <Hero label="miss cost usd" value={formatUsd(totals.missCostUsd)} />
      </div>
      {totals.unpricedModels > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          {totals.unpricedModels} models unpriced{" "}
          {onReviewUnpriced === undefined ? null : (
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={onReviewUnpriced}
            >
              review
            </button>
          )}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What a page renders while it has no data.
 *
 * `absent` is the interesting one: the server half of the spend module may not
 * be installed yet, and the honest answer is the page's own skeleton plus one
 * line. Rendering zeros there would be a lie a reader cannot detect.
 */
export function QueryFrame<T>({
  query,
  children,
}: {
  query: SpendQuery<T>;
  children: (data: T) => ReactNode;
}) {
  if (query.kind === "loading") {
    return <PageSkeleton />;
  }
  if (query.kind === "absent") {
    return (
      <div className="flex flex-col gap-3">
        <PageSkeleton />
        <p className="text-[11px] text-muted-foreground">{ABSENT_MESSAGE}</p>
      </div>
    );
  }
  if (query.kind === "error") {
    return <p className="text-[13px] text-muted-foreground">{query.message}</p>;
  }
  return <>{children(query.data)}</>;
}

/** The shape a page holds before its numbers arrive. */
export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-4 gap-6">
        {[0, 1, 2, 3].map((slot) => (
          <Skeleton key={slot} className="h-8 w-full rounded-[4px]" />
        ))}
      </div>
      <Skeleton className="h-40 w-full rounded-[4px]" />
    </div>
  );
}

/**
 * The footnote PRODUCT invariant 27 pairs with the superscript mark. Rendered
 * only when a table actually holds an estimate, so it never explains a symbol
 * the reader cannot see.
 */
export function EstimateFootnote({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="text-[11px] text-muted-foreground">
      {ESTIMATE_MARK} estimated, calibrated against the first turn's cache write
    </p>
  );
}

/** A right-aligned numeric header cell carrying the column's unit. */
export function NumHead({ children }: { children: ReactNode }) {
  return (
    <th className="whitespace-nowrap px-2 py-1 text-right font-normal tabular-nums">{children}</th>
  );
}

/** A left-aligned label header cell. */
export function TextHead({ children }: { children: ReactNode }) {
  return <th className="whitespace-nowrap px-2 py-1 text-left font-normal">{children}</th>;
}

/** A right-aligned numeric body cell on a 24px row. */
export function Num({ children }: { children: ReactNode }) {
  return <td className="h-6 whitespace-nowrap px-2 py-0 text-right tabular-nums">{children}</td>;
}
