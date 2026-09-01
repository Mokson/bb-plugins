// The cache-miss drilldown.
//
// One block per miss: the turn pair that straddles it, how far the cache read
// fell, the classified cause, and every correlate observed between the two
// turns in the order PRODUCT invariant 18 fixes. The classified cause is the
// first of those correlates, so showing the whole list is what makes the
// classification auditable rather than a verdict.
import { useEffect } from "react";
import { Heading } from "@/components/spend-common";
import { QueryFrame } from "@/components/spend-common";
import {
  formatCount,
  formatPercent,
  formatTime,
  formatTokens,
  formatUsd,
} from "@/lib/format";
import { useSpendQuery } from "@/lib/spend-rpc";
import { fixtureCacheMisses } from "@/fixtures/spend";
import {
  DEFAULT_FILTERS,
  readStoredFilters,
  resolveFilters,
  syncFilterSearch,
} from "@/lib/filters";
import type { CacheMissRow, SpendCacheMisses } from "../../spend/contract.js";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

/**
 * What survived of the prior turn's cache, as a percentage. A miss opens below
 * 40 percent, so this number is the reader's check on the rule that fired.
 */
function retainedPercent(row: CacheMissRow): number | null {
  if (row.priorCacheRead <= 0) return null;
  return (row.cacheRead / row.priorCacheRead) * 100;
}

function MissBlock({ row }: { row: CacheMissRow }) {
  return (
    <article className="flex flex-col gap-1 border-t border-border py-2 text-[13px]">
      <div className="flex flex-wrap items-baseline gap-4">
        <span className="font-semibold">{row.cause}</span>
        <Field label="thread" value={row.threadId} />
        <Field label="at" value={formatTime(row.at)} />
        <Field label="recurrence 7d" value={formatCount(row.recurrence7d)} />
      </div>
      <div className="flex flex-wrap items-baseline gap-4">
        <Field label="prev turn" value={row.prevTurnId} />
        <Field label="turn" value={row.turnId} />
        <Field
          label="cache read tok"
          value={`${formatTokens(row.priorCacheRead)} to ${formatTokens(row.cacheRead)}`}
        />
        <Field label="drop tok" value={formatTokens(row.drop)} />
        <Field label="retained" value={formatPercent(retainedPercent(row))} />
        <Field label="est usd" value={formatUsd(row.estimatedUsd)} />
      </div>
      {row.correlates.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          unknown: no transcript for provider {row.provider ?? "unknown"}
        </p>
      ) : (
        <ol className="flex flex-col">
          {row.correlates.map((correlate, index) => (
            <li
              // Two correlates of the same kind can share a timestamp - two
              // skills injected in one turn is the common case - and the pair
              // is not unique. The list is ordered evidence, so its index is.
              key={`${index}-${correlate.kind}-${correlate.at}`}
              className="flex h-6 items-center gap-2"
            >
              <span className="w-4 text-[11px] tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <span className="w-40 truncate">{correlate.kind}</span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {formatTime(correlate.at)}
              </span>
              <span className="truncate text-muted-foreground">
                {correlate.detail}
              </span>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}

/**
 * `threadId` scopes the drilldown to one thread - the shape the thread Cost
 * tab links into when a sparkline spike is clicked. Undefined shows the whole
 * range.
 */
export function CostCache({ threadId }: { threadId?: string }) {
  // Same precedence as the overview: URL over storage over default. The
  // overview reconciles those two on mount, so arriving here through
  // `toPluginPanel` - which carries a subPath and drops the query - inherits
  // the range that was on screen rather than a stale sticky one.
  const filters =
    typeof window === "undefined"
      ? DEFAULT_FILTERS
      : resolveFilters(
          new URLSearchParams(window.location.search),
          readStoredFilters(),
        );
  const range = filters.range;

  // The drilldown's own address states its range, so it survives a reload and
  // can be copied.
  useEffect(() => {
    syncFilterSearch(filters);
  }, [range, filters.group, filters.host, filters.provider]);

  const query = useSpendQuery<SpendCacheMisses>(
    "observatory_spend_cache_misses",
    { range, ...(threadId === undefined ? {} : { threadId }) },
    fixtureCacheMisses,
  );

  return (
    <section className="flex flex-col gap-3 py-4">
      <Heading>Cache misses</Heading>
      <p className="text-[11px] text-muted-foreground">
        range {range}
        {threadId === undefined ? "" : ` · thread ${threadId}`}
      </p>
      <QueryFrame query={query}>
        {(data) =>
          data.rows.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              No cache misses opened in this range.
            </p>
          ) : (
            <div className="flex flex-col">
              {data.rows.map((row) => (
                <MissBlock key={`${row.threadId}-${row.turnId}`} row={row} />
              ))}
            </div>
          )
        }
      </QueryFrame>
    </section>
  );
}
