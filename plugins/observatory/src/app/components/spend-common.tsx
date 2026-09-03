// The pieces every spend surface shares: the four hero numbers, the table
// chrome, and the one frame that decides what a page shows before its data
// arrives.
//
// Density contract (PRODUCT invariant 34): sizes 11, 13, 16, and 24 for at
// most four hero numbers; weights 400 and 600; 24px rows; hairlines, never
// boxes; numerics right-aligned with tabular figures and the unit in the
// header. Nothing here carries colour as meaning, so the same markup reads the
// same in either theme and in a screenshot.
import type * as React from "react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ESTIMATE_MARK, formatUsd } from "@/lib/format";
import { type ModuleQuery } from "@/lib/module-rpc";
import type { SpendRange, SpendTotals } from "../../spend/contract.js";

/** Every control on a panel page: 24px tall, 11px, one hairline, radius 4. */
export const SELECT_CLASS =
  "h-6 rounded-[4px] border border-border bg-transparent px-1 text-[11px]";

/** The ranges every ranged page offers, in the order the contract lists them. */
export const RANGE_OPTIONS: readonly SpendRange[] = ["1d", "7d", "30d", "90d"];

/** The one range control the audit pages share with the cost filter bar. */
export function RangeSelect({
  value,
  onChange,
}: {
  value: SpendRange;
  onChange: (next: SpendRange) => void;
}) {
  return (
    <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
      range
      <select
        className={SELECT_CLASS}
        value={value}
        onChange={(event) => onChange(event.target.value as SpendRange)}
      >
        {RANGE_OPTIONS.map((range) => (
          <option key={range} value={range}>
            {range}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A section heading. 16px, the only size above body on a page. */
export function Heading({ children }: { children: ReactNode }) {
  return <h2 className="text-[16px] font-semibold">{children}</h2>;
}

/**
 * The row a page's hero numbers sit in.
 *
 * An auto-fit grid rather than four fixed columns: the panel is resizable and
 * a 24px number in a 900px-wide panel would otherwise be squeezed into a
 * column narrower than its own digits and collide with its neighbour. Below
 * roughly four times the 160px minimum the row wraps instead.
 */
export function HeroRow({ children }: { children: ReactNode }) {
  return (
    <div
      className="grid gap-6"
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))" }}
    >
      {children}
    </div>
  );
}

/**
 * One 11px label above a 24px number. Never more than four in a row.
 *
 * The label may wrap onto a second line; the number may not. Keeping the two
 * in a column means a wrapped label pushes its own number down rather than
 * shifting the one beside it, so the row stays readable at any width.
 */
export function Hero({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
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
      <HeroRow>
        <Hero label="spend usd" value={formatUsd(totals.spendUsd)} />
        <Hero label="cache saved usd" value={formatUsd(totals.cacheSavedUsd)} />
        <Hero label="cache write usd" value={formatUsd(totals.cacheWriteUsd)} />
        <Hero label="miss cost usd" value={formatUsd(totals.missCostUsd)} />
      </HeroRow>
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
  query: ModuleQuery<T>;
  children: (data: T) => ReactNode;
}) {
  if (query.kind === "loading") {
    return <PageSkeleton />;
  }
  if (query.kind === "absent") {
    return (
      <div className="flex flex-col gap-3">
        <PageSkeleton />
        <p className="text-[11px] text-muted-foreground">{query.message}</p>
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
      <HeroRow>
        {[0, 1, 2, 3].map((slot) => (
          <Skeleton key={slot} className="h-8 w-full rounded-[4px]" />
        ))}
      </HeroRow>
      <Skeleton className="h-40 w-full rounded-[4px]" />
    </div>
  );
}

/**
 * The truncation notice, paired with the `truncated` flag the rollups set.
 * The cap bounds the payload, never the money: totals are computed over the
 * uncapped rows, so the line says the rows are capped and the totals complete
 * in the same breath. Rendered only when a table actually is truncated, so it
 * never explains a state the reader cannot see.
 */
export function TruncatedNotice({
  show,
  shown,
  unit,
}: {
  show: boolean | undefined;
  shown: number;
  unit: string;
}) {
  if (!show) return null;
  return (
    <p className="text-[11px] text-muted-foreground">
      showing the first {shown} {unit}; totals cover all {unit}
    </p>
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

/**
 * A panel table, inside the block it scrolls sideways in.
 *
 * Panel tables keep their cells on one line - a lineage row wrapped over three
 * lines stops being a row - so a table's own width is its content's width, not
 * its container's. Left in normal flow the surplus is simply clipped by the
 * panel and the right-hand columns are unreachable at any narrow width, which
 * is what a phone sees. Scrolling here rather than on the panel root means the
 * sideways scroll belongs to the one table that needs it, and the page still
 * scrolls down as a whole.
 *
 * The scroll block and the table are one component rather than a wrapper each
 * caller remembers to add separately: a table that keeps its cells on one line
 * and a block that lets them be reached are one decision, so they are one
 * type. A table whose cells wrap - the two-column key/value pairs on the
 * settings route, the `?` shortcut sheet - has no width to scroll and stays a
 * plain `<table>`.
 */
export function DataTable({
  className,
  children,
  ...props
}: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full max-w-full overflow-x-auto">
      <table className={className} {...props}>
        {children}
      </table>
    </div>
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
