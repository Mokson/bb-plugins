// Spend rollups: SQL over `obs_turn` joined to `obs_thread`, nothing else.
//
// The one rule the whole file exists to hold: a group's cache split is NULL
// when ANY turn in it has an unproven split. `SUM(cache_read_tokens)` in
// sqlite silently skips NULLs, so the naive aggregate would report the reads
// it happens to know as if they were the reads that happened, and the number
// would land under a confident heading on the cost page. Every aggregate here
// therefore counts its own NULLs and the TypeScript side collapses a partial
// sum back to null.
//
// Cost is the same shape with a different rule: a NULL cost means "unmeasured"
// (the model resolved to no price), so the sum reports what IS priced and the
// row carries `estimated` whenever anything under it was not a figure the
// biller produced.
import type { Database } from "better-sqlite3";
import { resolveModel, type PricingCatalog } from "../core/catalog.js";
import type {
  SpendGroup,
  SpendOverview,
  SpendRange,
  SpendRow,
  SpendThreadView,
  SpendToday,
  SpendTotals,
  TurnRow,
} from "./contract.js";

/** Rates are published per million tokens. */
const PER_MILLION = 1_000_000;

const RANGE_DAYS: Record<SpendRange, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

/** The inclusive lower bound of a range, as the ISO string turns are stored in. */
export function rangeStart(range: SpendRange, now: number): string {
  return new Date(now - RANGE_DAYS[range] * 24 * 60 * 60 * 1_000).toISOString();
}

/** The aggregate columns every grouping selects, so the rules stay in one place. */
const AGGREGATES = `
  COUNT(*)                                                    AS turns,
  COALESCE(SUM(t.input_tokens), 0)                            AS input_tokens,
  COALESCE(SUM(t.output_tokens), 0)                           AS output_tokens,
  SUM(CASE WHEN t.cache_read_tokens IS NULL THEN 1 ELSE 0 END)  AS read_nulls,
  COALESCE(SUM(t.cache_read_tokens), 0)                       AS read_sum,
  SUM(CASE WHEN t.cache_write_tokens IS NULL THEN 1 ELSE 0 END) AS write_nulls,
  COALESCE(SUM(t.cache_write_tokens), 0)                      AS write_sum,
  SUM(CASE WHEN t.cost_usd IS NULL THEN 0 ELSE 1 END)         AS priced_turns,
  COALESCE(SUM(t.cost_usd), 0)                                AS cost_sum,
  SUM(CASE WHEN t.cost_source = 'logged' THEN 0 ELSE 1 END)   AS non_logged
`;

interface AggregateRow {
  turns: number;
  input_tokens: number;
  output_tokens: number;
  read_nulls: number;
  read_sum: number;
  write_nulls: number;
  write_sum: number;
  priced_turns: number;
  cost_sum: number;
  non_logged: number;
}

const ZERO: AggregateRow = {
  turns: 0,
  input_tokens: 0,
  output_tokens: 0,
  read_nulls: 0,
  read_sum: 0,
  write_nulls: 0,
  write_sum: 0,
  priced_turns: 0,
  cost_sum: 0,
  non_logged: 0,
};

function add(a: AggregateRow, b: AggregateRow): AggregateRow {
  return {
    turns: a.turns + b.turns,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    read_nulls: a.read_nulls + b.read_nulls,
    read_sum: a.read_sum + b.read_sum,
    write_nulls: a.write_nulls + b.write_nulls,
    write_sum: a.write_sum + b.write_sum,
    priced_turns: a.priced_turns + b.priced_turns,
    cost_sum: a.cost_sum + b.cost_sum,
    non_logged: a.non_logged + b.non_logged,
  };
}

/** The aggregate turned into the wire row's numeric fields. */
function measures(agg: AggregateRow): Omit<SpendRow, "key" | "label" | "depth" | "kind"> {
  return {
    turns: agg.turns,
    inputTokens: agg.input_tokens,
    // The whole point of the file: a partial split is not a number.
    cacheReadTokens: agg.read_nulls > 0 ? null : agg.read_sum,
    cacheWriteTokens: agg.write_nulls > 0 ? null : agg.write_sum,
    outputTokens: agg.output_tokens,
    costUsd: agg.priced_turns === 0 ? null : agg.cost_sum,
    estimated: agg.non_logged > 0,
  };
}

export interface OverviewQuery {
  range: SpendRange;
  /** Reserved: `obs_thread` carries no host id, so this does not narrow. */
  host?: string;
  provider?: string;
  group: SpendGroup;
  /** CLI-only: narrow to the threads attributed to one deliver run folder. */
  runFolder?: string;
}

interface Filter {
  where: string;
  params: Record<string, string>;
}

/**
 * One filter builder for every spend surface. The thread drilldown reuses it
 * so its totals are computed by the same code as the overview's: the earlier
 * shape hard-coded two of a thread's totals to zero, and a zero on a cost page
 * reads as "no cache writes" rather than "not computed here".
 */
function buildFilter(
  query: Partial<OverviewQuery> & { threadId?: string },
  now: number,
): Filter {
  const params: Record<string, string> = {};
  let where = "1 = 1";
  if (query.range !== undefined) {
    params["from"] = rangeStart(query.range, now);
    where += " AND t.started_at IS NOT NULL AND t.started_at >= @from";
  }
  if (query.threadId !== undefined) {
    where += " AND t.thread_id = @threadId";
    params["threadId"] = query.threadId;
  }
  if (query.provider !== undefined && query.provider !== "") {
    where += " AND th.provider_id = @provider";
    params["provider"] = query.provider;
  }
  if (query.runFolder !== undefined && query.runFolder !== "") {
    where += " AND th.run_folder = @runFolder";
    params["runFolder"] = query.runFolder;
  }
  return { where, params };
}

/** Cost desc with nulls last, then turns desc, then key, so output is stable. */
function byCost(a: SpendRow, b: SpendRow): number {
  const left = a.costUsd ?? -1;
  const right = b.costUsd ?? -1;
  if (left !== right) return right - left;
  if (a.turns !== b.turns) return b.turns - a.turns;
  return a.key.localeCompare(b.key);
}

interface ThreadAggregate extends AggregateRow {
  thread_id: string;
  root_thread_id: string | null;
  parent_thread_id: string | null;
  depth: number;
  title: string | null;
  seat: string | null;
}

function labelFor(row: { title: string | null; thread_id: string }): string {
  return row.title?.trim() || row.thread_id;
}

function lineageRows(threads: readonly ThreadAggregate[]): SpendRow[] {
  const unparented = threads.filter((row) => !row.root_thread_id);
  const parented = threads.filter((row) => row.root_thread_id);

  const byRoot = new Map<string, ThreadAggregate[]>();
  for (const row of parented) {
    const root = row.root_thread_id as string;
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(row);
    else byRoot.set(root, [row]);
  }

  const trees: Array<{ root: SpendRow; children: SpendRow[] }> = [];
  for (const [rootId, members] of byRoot) {
    const rootRow = members.find((row) => row.thread_id === rootId);
    const descendants = members.filter((row) => row.thread_id !== rootId);
    const total = members.reduce<AggregateRow>((acc, row) => add(acc, row), ZERO);
    const root: SpendRow = {
      key: rootId,
      label: rootRow ? labelFor(rootRow) : rootId,
      depth: 0,
      kind: "thread",
      childCount: descendants.length,
      ...measures(total),
    };

    // Seats are the level that makes a deliver run readable: a root with
    // eleven children is a wall, a root with four seats is a report.
    const seats = new Map<string, ThreadAggregate[]>();
    const seatless: ThreadAggregate[] = [];
    for (const row of descendants) {
      if (!row.seat) {
        seatless.push(row);
        continue;
      }
      const bucket = seats.get(row.seat);
      if (bucket) bucket.push(row);
      else seats.set(row.seat, [row]);
    }

    const children: SpendRow[] = [];
    for (const [seat, members2] of seats) {
      const seatKey = `${rootId}:seat:${seat}`;
      const seatTotal = members2.reduce<AggregateRow>(
        (acc, row) => add(acc, row),
        ZERO,
      );
      const seatRow: SpendRow = {
        key: seatKey,
        label: seat,
        depth: 1,
        parentKey: rootId,
        kind: "seat",
        childCount: members2.length,
        ...measures(seatTotal),
      };
      const seatChildren = members2
        .map<SpendRow>((row) => ({
          key: row.thread_id,
          label: labelFor(row),
          depth: 2,
          parentKey: seatKey,
          kind: "thread",
          ...measures(row),
        }))
        .sort(byCost);
      children.push(seatRow, ...seatChildren);
    }
    const loose = seatless
      .map<SpendRow>((row) => ({
        key: row.thread_id,
        label: labelFor(row),
        depth: 1,
        parentKey: rootId,
        kind: "thread",
        ...measures(row),
      }))
      .sort(byCost);
    trees.push({ root, children: [...children, ...loose] });
  }

  trees.sort((a, b) => byCost(a.root, b.root));
  const rows = trees.flatMap((tree) => [tree.root, ...tree.children]);

  if (unparented.length > 0) {
    const total = unparented.reduce<AggregateRow>((acc, row) => add(acc, row), ZERO);
    rows.push({
      key: "unparented",
      label: "unparented",
      depth: 0,
      kind: "unparented",
      childCount: unparented.length,
      ...measures(total),
    });
  }
  return rows;
}

function flatRows(
  db: Database,
  filter: Filter,
  expression: string,
  kind: "model" | "day",
): SpendRow[] {
  const rows = db
    .prepare<Record<string, string>, AggregateRow & { key: string | null }>(
      `SELECT ${expression} AS key, ${AGGREGATES}
         FROM obs_turn t JOIN obs_thread th ON th.thread_id = t.thread_id
        WHERE ${filter.where}
        GROUP BY key`,
    )
    .all(filter.params);
  return rows
    .map<SpendRow>((row) => {
      const key = row.key ?? "unknown";
      return { key, label: key, depth: 0, kind, ...measures(row) };
    })
    .sort(kind === "day" ? (a, b) => b.key.localeCompare(a.key) : byCost);
}

function threadAggregates(db: Database, filter: Filter): ThreadAggregate[] {
  return db
    .prepare<Record<string, string>, ThreadAggregate>(
      `SELECT t.thread_id          AS thread_id,
              th.root_thread_id    AS root_thread_id,
              th.parent_thread_id  AS parent_thread_id,
              COALESCE(th.depth,0) AS depth,
              th.title             AS title,
              th.seat              AS seat,
              ${AGGREGATES}
         FROM obs_turn t JOIN obs_thread th ON th.thread_id = t.thread_id
        WHERE ${filter.where}
        GROUP BY t.thread_id`,
    )
    .all(filter.params);
}

/**
 * `cacheWriteUsd` is the only total that needs a price rather than a stored
 * column: nothing writes a per-turn write-cost, and summing one would mean
 * re-pricing on the ingest path. Turns with an unproven write split
 * contribute nothing, which under-reports rather than invents.
 */
function cacheWriteUsd(
  db: Database,
  filter: Filter,
  catalog: PricingCatalog | null,
): number {
  if (!catalog) return 0;
  const rows = db
    .prepare<
      Record<string, string>,
      { provider: string | null; model: string | null; written: number | null }
    >(
      `SELECT th.provider_id AS provider,
              COALESCE(t.model_reported, t.model_requested) AS model,
              SUM(t.cache_write_tokens) AS written
         FROM obs_turn t JOIN obs_thread th ON th.thread_id = t.thread_id
        WHERE ${filter.where} AND t.cache_write_tokens IS NOT NULL
        GROUP BY provider, model`,
    )
    .all(filter.params);
  let total = 0;
  for (const row of rows) {
    if (!row.written) continue;
    const price = resolveModel(catalog, row.provider ?? "", row.model)?.price;
    if (!price) continue;
    total += (row.written * price.cacheWrite) / PER_MILLION;
  }
  return total;
}

function totalsFor(
  db: Database,
  filter: Filter,
  catalog: PricingCatalog | null,
): SpendTotals {
  const base = db
    .prepare<
      Record<string, string>,
      { spend: number | null; saved: number | null }
    >(
      `SELECT SUM(t.cost_usd) AS spend, SUM(t.cache_savings_usd) AS saved
         FROM obs_turn t JOIN obs_thread th ON th.thread_id = t.thread_id
        WHERE ${filter.where}`,
    )
    .get(filter.params);
  const unpriced = db
    .prepare<Record<string, string>, { n: number }>(
      `SELECT COUNT(DISTINCT COALESCE(t.model_reported, t.model_requested, '')) AS n
         FROM obs_turn t JOIN obs_thread th ON th.thread_id = t.thread_id
        WHERE ${filter.where} AND t.cost_usd IS NULL`,
    )
    .get(filter.params);
  // Joined through the turn rather than filtered on `opened_at`, so the miss
  // cost obeys exactly the same filter as the spend it is compared against.
  // A range-only predicate here silently counted misses from other providers.
  const miss = db
    .prepare<Record<string, string>, { total: number | null }>(
      `SELECT SUM(CAST(json_extract(s.payload, '$.estimatedUsd') AS REAL)) AS total
         FROM obs_signal s
         JOIN obs_turn t
           ON t.thread_id = s.thread_id AND t.turn_id = s.turn_id
         JOIN obs_thread th ON th.thread_id = t.thread_id
        WHERE s.module = 'spend' AND s.kind = 'cache-miss' AND ${filter.where}`,
    )
    .get(filter.params);
  return {
    spendUsd: base?.spend ?? 0,
    cacheSavedUsd: base?.saved ?? 0,
    cacheWriteUsd: cacheWriteUsd(db, filter, catalog),
    missCostUsd: miss?.total ?? 0,
    unpricedModels: unpriced?.n ?? 0,
  };
}

export interface RollupDeps {
  db: Database;
  catalog?: PricingCatalog | null;
  now?: () => number;
}

export function spendOverview(
  deps: RollupDeps,
  query: OverviewQuery,
): SpendOverview {
  const now = (deps.now ?? Date.now)();
  const filter = buildFilter(query, now);
  const catalog = deps.catalog ?? null;
  const rows =
    query.group === "lineage"
      ? lineageRows(threadAggregates(deps.db, filter))
      : query.group === "model"
        ? flatRows(
            deps.db,
            filter,
            "COALESCE(t.model_reported, t.model_requested)",
            "model",
          )
        : flatRows(deps.db, filter, "substr(t.started_at, 1, 10)", "day");
  return { totals: totalsFor(deps.db, filter, catalog), rows };
}

/** Per-turn flags. Closed vocabulary, shared with `COST.md`. */
export function turnFlags(row: {
  model_requested: string | null;
  model_reported: string | null;
  compacted: number | null;
  split_source: string | null;
}): string[] {
  const flags: string[] = [];
  if (
    row.model_requested &&
    row.model_reported &&
    row.model_requested !== row.model_reported
  ) {
    flags.push("mismatch");
  }
  if (row.compacted) flags.push("compacted");
  if (!row.split_source || row.split_source === "unavailable") {
    flags.push("split-unavailable");
  }
  return flags;
}

interface TurnDetailRow {
  turn_id: string;
  started_at: string | null;
  duration_ms: number | null;
  model_requested: string | null;
  model_reported: string | null;
  effort: string | null;
  input_tokens: number;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  output_tokens: number;
  reasoning_tokens: number | null;
  cost_usd: number | null;
  cost_source: string | null;
  split_source: string | null;
  compacted: number | null;
}

export function spendThread(
  deps: RollupDeps,
  threadId: string,
): SpendThreadView {
  const { db } = deps;
  const thread = db
    .prepare<
      [string],
      {
        thread_id: string;
        title: string | null;
        provider_id: string | null;
        seat: string | null;
        tier_tag: string | null;
        run_folder: string | null;
      }
    >(
      `SELECT thread_id, title, provider_id, seat, tier_tag, run_folder
         FROM obs_thread WHERE thread_id = ?`,
    )
    .get(threadId);
  if (!thread) throw new Error(`unknown thread: ${threadId}`);

  const turns = db
    .prepare<[string], TurnDetailRow>(
      `SELECT turn_id, started_at, duration_ms, model_requested, model_reported,
              effort, COALESCE(input_tokens,0) AS input_tokens,
              cache_read_tokens, cache_write_tokens,
              COALESCE(output_tokens,0) AS output_tokens, reasoning_tokens,
              cost_usd, cost_source, split_source, compacted
         FROM obs_turn WHERE thread_id = ?
        ORDER BY COALESCE(started_at, ''), turn_id`,
    )
    .all(threadId);

  const rows: TurnRow[] = turns.map((turn) => ({
    turnId: turn.turn_id,
    startedAt: turn.started_at ?? "",
    durationMs: turn.duration_ms,
    modelRequested: turn.model_requested,
    modelReported: turn.model_reported,
    effort: turn.effort,
    inputTokens: turn.input_tokens,
    cacheReadTokens: turn.cache_read_tokens,
    cacheWriteTokens: turn.cache_write_tokens,
    outputTokens: turn.output_tokens,
    reasoningTokens: turn.reasoning_tokens,
    costUsd: turn.cost_usd,
    costSource: turn.cost_source ?? "unknown",
    splitSource: turn.split_source ?? "unavailable",
    flags: turnFlags(turn),
  }));

  return {
    thread: {
      threadId: thread.thread_id,
      title: thread.title ?? thread.thread_id,
      provider: thread.provider_id ?? "unknown",
      seat: thread.seat,
      tier: thread.tier_tag,
      runFolder: thread.run_folder,
    },
    totals: totalsFor(
      db,
      buildFilter({ threadId }, (deps.now ?? Date.now)()),
      deps.catalog ?? null,
    ),
    turns: rows,
  };
}

/** `n/a` reads as unmeasured; `0` reads as free, and only one of those is true. */
function money(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(4);
}

function tokens(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

/** The CLI rendering of an overview. The rpc returns the same object unformatted. */
export function formatOverview(overview: SpendOverview): string {
  const { totals } = overview;
  const lines = [
    `spend            ${money(totals.spendUsd)}`,
    `cache saved      ${money(totals.cacheSavedUsd)}`,
    `cache writes     ${money(totals.cacheWriteUsd)}`,
    `cache miss cost  ${money(totals.missCostUsd)}`,
    `unpriced models  ${totals.unpricedModels}`,
    "",
    `${"row".padEnd(52)} ${"turns".padStart(6)} ${"in".padStart(10)} ${"read".padStart(10)} ${"out".padStart(10)} ${"usd".padStart(10)}`,
  ];
  for (const row of overview.rows) {
    const label = `${"  ".repeat(row.depth)}${row.label}`;
    lines.push(
      `${label.slice(0, 52).padEnd(52)} ${String(row.turns).padStart(6)} ${tokens(
        row.inputTokens,
      ).padStart(10)} ${tokens(row.cacheReadTokens).padStart(10)} ${tokens(
        row.outputTokens,
      ).padStart(10)} ${(money(row.costUsd) + (row.estimated ? "~" : "")).padStart(10)}`,
    );
  }
  if (overview.rows.length === 0) lines.push("  (no priced turns in range)");
  return lines.join("\n");
}

/**
 * One cell of a markdown table.
 *
 * A thread title is free text and a pipe in it splits the row: the eight-column
 * contract every consumer parses by position becomes nine columns for that row
 * alone. A newline is worse still, because it ends the row mid-table. Both are
 * neutralised here rather than at each call site, so every markdown surface in
 * the module escapes identically.
 */
export function markdownCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/[\r\n]+/gu, " ");
}

/** The markdown half of `observatory_spend_export`. */
export function overviewMarkdown(
  overview: SpendOverview,
  query: OverviewQuery,
): string {
  const header = [
    `# Spend ${query.range} by ${query.group}`,
    "",
    // The active filters are echoed so an exported file states the slice it
    // covers. A file that says "all" when a provider filter was on is a file
    // whose totals cannot be trusted a week later.
    `host: ${markdownCell((query.host ?? "") || "all")}`,
    `provider: ${markdownCell((query.provider ?? "") || "all")}`,
    `spend_usd: ${money(overview.totals.spendUsd)}`,
    `cache_saved_usd: ${money(overview.totals.cacheSavedUsd)}`,
    `cache_write_usd: ${money(overview.totals.cacheWriteUsd)}`,
    `cache_miss_usd: ${money(overview.totals.missCostUsd)}`,
    `unpriced_models: ${overview.totals.unpricedModels}`,
    "",
    "| row | kind | turns | input | cache read | output | cost usd | estimated |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const rows = overview.rows.map(
    (row) =>
      `| ${"  ".repeat(row.depth)}${markdownCell(row.label)} | ${
        row.kind
      } | ${row.turns} | ${
        row.inputTokens
      } | ${tokens(row.cacheReadTokens)} | ${row.outputTokens} | ${money(
        row.costUsd,
      )} | ${row.estimated ? "yes" : "no"} |`,
  );
  return [...header, ...rows, ""].join("\n");
}

export function spendExport(
  deps: RollupDeps,
  query: OverviewQuery & { format: "md" | "json" },
): { content: string; filename: string } {
  const overview = spendOverview(deps, query);
  const stamp = new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10);
  return query.format === "json"
    ? {
        content: `${JSON.stringify(overview, null, 2)}\n`,
        filename: `spend-${query.range}-${query.group}-${stamp}.json`,
      }
    : {
        content: overviewMarkdown(overview, query),
        filename: `spend-${query.range}-${query.group}-${stamp}.md`,
      };
}

export function spendToday(deps: RollupDeps): SpendToday {
  const now = (deps.now ?? Date.now)();
  const from = new Date(now).toISOString().slice(0, 10);
  const row = deps.db
    .prepare<
      [string],
      { spend: number | null; turns: number; threads: number }
    >(
      `SELECT SUM(cost_usd) AS spend, COUNT(*) AS turns,
              COUNT(DISTINCT thread_id) AS threads
         FROM obs_turn WHERE started_at >= ?`,
    )
    .get(`${from}T00:00:00.000Z`);
  return {
    spendUsd: row?.spend ?? 0,
    turns: row?.turns ?? 0,
    threads: row?.threads ?? 0,
    updatedAt: new Date(now).toISOString(),
  };
}
