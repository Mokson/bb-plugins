// The cost overview: filters, four hero numbers, one grouped table.
//
// The table is the page. The lineage tab is a thread/seat tree the server
// returns already flattened and ordered, so folding is the only thing this
// file decides about shape; the model and day tabs reuse the same table with
// every row at depth 0 and nothing to fold.
import { useCallback, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  EstimateFootnote,
  Heading,
  Heroes,
  Num,
  NumHead,
  QueryFrame,
  TextHead,
} from "@/components/spend-common";
import { formatCount, formatTokens, formatUsd } from "@/lib/format";
import {
  DEFAULT_FILTERS,
  GROUPS,
  RANGES,
  overviewInput,
  readStoredFilters,
  resolveFilters,
  writeStoredFilters,
  type Filters,
} from "@/lib/filters";
import { toggleKey, visibleRows } from "@/lib/rows";
import { useSpendQuery } from "@/lib/spend-rpc";
import { fixtureOverview } from "@/fixtures/spend";
import { PANEL_PATH } from "./routes.js";
import type {
  SpendGroup,
  SpendOverview,
  SpendRow,
} from "../../spend/contract.js";

const GROUP_TITLES: Record<SpendGroup, string> = {
  lineage: "Lineage",
  model: "Model",
  day: "Day",
};

const SELECT_CLASS =
  "h-6 rounded-[4px] border border-border bg-transparent px-1 text-[11px]";

/**
 * Filter state resolved once on mount from the URL over storage, then owned
 * by the page. Later edits persist but do not rewrite the URL: the SDK's
 * `toPluginPanel` carries a subPath and no query, so a filter change cannot
 * push a new address without losing the panel's own history.
 */
function useFilters(): [Filters, (next: Filters) => void] {
  const [filters, setFilters] = useState<Filters>(() =>
    typeof window === "undefined"
      ? DEFAULT_FILTERS
      : resolveFilters(
          new URLSearchParams(window.location.search),
          readStoredFilters(),
        ),
  );

  const update = useCallback((next: Filters) => {
    setFilters(next);
    writeStoredFilters(next);
  }, []);

  return [filters, update];
}

function FilterBar({
  filters,
  onChange,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      <label className="flex items-center gap-1">
        range
        <select
          className={SELECT_CLASS}
          value={filters.range}
          onChange={(event) =>
            onChange({
              ...filters,
              range: event.target.value as Filters["range"],
            })
          }
        >
          {RANGES.map((range) => (
            <option key={range} value={range}>
              {range}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1">
        host
        <input
          className={SELECT_CLASS}
          value={filters.host}
          placeholder="all"
          onChange={(event) =>
            onChange({ ...filters, host: event.target.value })
          }
        />
      </label>
      <label className="flex items-center gap-1">
        provider
        <input
          className={SELECT_CLASS}
          value={filters.provider}
          placeholder="all"
          onChange={(event) =>
            onChange({ ...filters, provider: event.target.value })
          }
        />
      </label>
    </div>
  );
}

/**
 * Download an export the server rendered. Absent server: the buttons say so
 * in the same one line the page uses, rather than producing an empty file.
 */
function ExportActions({ filters }: { filters: Filters }) {
  // The export is a user action, not a page load, so it posts on click rather
  // than through `useSpendQuery`. A missing server half surfaces the same way
  // any other failure does: one line beside the buttons, no empty download.
  const [note, setNote] = useState<string | null>(null);

  const run = useCallback(
    async (format: "md" | "json") => {
      setNote(null);
      try {
        const response = await fetch(
          "/api/v1/plugins/observatory/rpc/observatory_spend_export",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({
              range: filters.range,
              group: filters.group,
              format,
            }),
          },
        );
        const payload = (await response.json()) as {
          ok?: boolean;
          result?: { content: string; filename: string };
          error?: { message?: string };
        };
        if (!response.ok || payload.ok !== true || payload.result === undefined) {
          throw new Error(payload.error?.message ?? "export unavailable");
        }
        const url = URL.createObjectURL(
          new Blob([payload.result.content], { type: "text/plain" }),
        );
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = payload.result.filename;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch (error) {
        setNote(error instanceof Error ? error.message : "export unavailable");
      }
    },
    [filters.range, filters.group],
  );

  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-muted-foreground">export</span>
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={() => void run("md")}
      >
        MD
      </button>
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={() => void run("json")}
      >
        JSON
      </button>
      {note === null ? null : (
        <span className="text-muted-foreground">{note}</span>
      )}
    </div>
  );
}

function RowLabel({
  row,
  hasChildren,
  collapsed,
  onToggle,
  onOpen,
}: {
  row: SpendRow;
  hasChildren: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  return (
    <td className="h-6 px-2 py-0">
      <span
        className="flex items-center gap-1"
        style={{ paddingLeft: `${row.depth * 12}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="w-3 text-left text-muted-foreground"
            aria-expanded={!collapsed}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${row.label}`}
            onClick={onToggle}
          >
            {collapsed ? "+" : "-"}
          </button>
        ) : (
          <span className="w-3" />
        )}
        {row.kind === "thread" ? (
          <button
            type="button"
            className="truncate text-left underline underline-offset-2"
            onClick={onOpen}
          >
            {row.label}
          </button>
        ) : (
          <span className="truncate">{row.label}</span>
        )}
        <span className="text-[11px] text-muted-foreground">{row.kind}</span>
      </span>
    </td>
  );
}

function OverviewTable({
  overview,
  onOpenThread,
}: {
  overview: SpendOverview;
  onOpenThread: (threadId: string) => void;
}) {
  const [collapsedKeys, setCollapsedKeys] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const rows = visibleRows(overview.rows, collapsedKeys);

  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-[11px] text-muted-foreground">
          <TextHead>row</TextHead>
          <NumHead>turns</NumHead>
          <NumHead>input tok</NumHead>
          <NumHead>cache read tok</NumHead>
          <NumHead>cache write tok</NumHead>
          <NumHead>output tok</NumHead>
          <NumHead>cost usd</NumHead>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ row, hasChildren, collapsed }) => (
          <tr key={row.key} className="border-t border-border">
            <RowLabel
              row={row}
              hasChildren={hasChildren}
              collapsed={collapsed}
              onToggle={() =>
                setCollapsedKeys((current) => toggleKey(current, row.key))
              }
              onOpen={() => onOpenThread(row.key)}
            />
            <Num>{formatCount(row.turns)}</Num>
            <Num>{formatTokens(row.inputTokens, row.estimated)}</Num>
            <Num>{formatTokens(row.cacheReadTokens, row.estimated)}</Num>
            <Num>{formatTokens(row.cacheWriteTokens, row.estimated)}</Num>
            <Num>{formatTokens(row.outputTokens, row.estimated)}</Num>
            <Num>{formatUsd(row.costUsd, row.estimated)}</Num>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CostOverview() {
  const navigate = useBbNavigate();
  const [filters, setFilters] = useFilters();
  const query = useSpendQuery<SpendOverview>(
    "observatory_spend_overview",
    overviewInput(filters),
    fixtureOverview,
  );

  const goTo = useCallback(
    (subPath: string) => navigate.toPluginPanel(PANEL_PATH, { subPath }),
    [navigate],
  );

  return (
    <section className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading>Cost</Heading>
        <ExportActions filters={filters} />
      </div>
      <FilterBar filters={filters} onChange={setFilters} />
      <Tabs
        value={filters.group}
        onValueChange={(next) =>
          setFilters({ ...filters, group: next as SpendGroup })
        }
      >
        <TabsList>
          {GROUPS.map((group) => (
            <TabsTrigger key={group} value={group}>
              {GROUP_TITLES[group]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <QueryFrame query={query}>
        {(overview) => (
          <>
            <Heroes
              totals={overview.totals}
              onReviewUnpriced={() => goTo("settings")}
            />
            <OverviewTable
              overview={overview}
              onOpenThread={(threadId) => goTo(`threads/${threadId}`)}
            />
            <EstimateFootnote
              show={overview.rows.some((row) => row.estimated)}
            />
            <button
              type="button"
              className="self-start text-[11px] underline underline-offset-2"
              onClick={() => goTo("cost/cache")}
            >
              cache misses
            </button>
          </>
        )}
      </QueryFrame>
    </section>
  );
}
