// The pricing catalog: models.dev rates, cached in `pricing_catalog`.
//
// Three layers, deliberately in this order:
//
//   1. the row in `pricing_catalog`, when it is younger than `refreshHours`;
//   2. a live fetch of models.dev, which then becomes that row;
//   3. the snapshot compiled into this plugin.
//
// Layer 3 is what makes the plugin work on a machine with no network, and it
// is why the fetch is never awaited on a hot path: a cost page that blocks on
// a third-party HTTP call is a cost page that hangs.
//
// The `fetch` argument exists so tests drive every branch without a socket.
import type { Database } from "better-sqlite3";
import { SNAPSHOT_JSON, SNAPSHOT_REVISION } from "./pricing-snapshot.js";

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type PricingStatus = "exact" | "alias" | "prefix" | "logged" | "unknown";

export interface PricingCatalog {
  /** Which snapshot this is, for the "prices as of" line. */
  revision: string;
  /** provider id -> model id -> price. Both keys are lowercased. */
  providers: Record<string, Record<string, ModelPrice>>;
}

export interface LoadCatalogOptions {
  /** Do not refetch a row younger than this. */
  refreshHours: number;
  fetch?: typeof globalThis.fetch;
  /** Injectable for tests. */
  now?: () => number;
}

/** models.dev's public JSON. */
export const MODELS_DEV_URL = "https://models.dev/api.json";

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Provider ids that differ between the harnesses' logs and models.dev.
 *
 * `claude-code` and `omp` are this plugin's own provider tags for a log root,
 * not vendor names, so they have to be mapped or nothing would ever resolve.
 */
const PROVIDER_ALIASES: Record<string, string> = {
  "claude-code": "anthropic",
  claude: "anthropic",
  codex: "openai",
  omp: "opencode",
  pi: "opencode",
  "bb-pi-bridge": "opencode",
  bedrock: "amazon-bedrock",
  vertex: "google-vertex",
  "x-ai": "xai",
  copilot: "github-copilot",
};

export function normalizeProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase().replace(/_/g, "-");
  return PROVIDER_ALIASES[normalized] ?? (normalized || "unknown");
}

// The compiled snapshot stores prices as `{i,o,r,w}` to keep the bundled
// string small; nothing outside this function sees that shape.
interface CompactPrice {
  i: number;
  o: number;
  r?: number;
  w?: number;
}

function expand(compact: CompactPrice): ModelPrice | null {
  if (!Number.isFinite(compact.i) || !Number.isFinite(compact.o)) return null;
  const input = Math.max(0, compact.i);
  const output = Math.max(0, compact.o);
  return {
    input,
    output,
    // A model with no published cache rate bills cache tokens at the input
    // rate. That is the conservative direction: it never understates.
    cacheRead: Number.isFinite(compact.r) ? Math.max(0, compact.r!) : input,
    cacheWrite: Number.isFinite(compact.w) ? Math.max(0, compact.w!) : input,
  };
}

/** models.dev's live shape, which nests `cost` under each model. */
function fromModelsDev(raw: unknown): PricingCatalog["providers"] | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const providers: PricingCatalog["providers"] = {};
  for (const [providerId, provider] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const models = (provider as { models?: unknown })?.models;
    if (!models || typeof models !== "object") continue;
    const table: Record<string, ModelPrice> = {};
    for (const [modelId, model] of Object.entries(
      models as Record<string, unknown>,
    )) {
      const cost = (model as { cost?: Record<string, unknown> })?.cost;
      if (!cost) continue;
      const price = expand({
        i: Number(cost.input),
        o: Number(cost.output),
        r: cost.cache_read === undefined ? undefined : Number(cost.cache_read),
        w: cost.cache_write === undefined ? undefined : Number(cost.cache_write),
      });
      if (price) table[modelId.toLowerCase()] = price;
    }
    if (Object.keys(table).length) providers[providerId.toLowerCase()] = table;
  }
  return Object.keys(providers).length ? providers : null;
}

let snapshotCache: PricingCatalog | null = null;

/** The catalog compiled into the plugin. Always available, never fetched. */
export function bundledCatalog(): PricingCatalog {
  if (!snapshotCache) {
    const raw = JSON.parse(SNAPSHOT_JSON) as Record<
      string,
      Record<string, CompactPrice>
    >;
    const providers: PricingCatalog["providers"] = {};
    for (const [providerId, models] of Object.entries(raw)) {
      const table: Record<string, ModelPrice> = {};
      for (const [modelId, compact] of Object.entries(models)) {
        const price = expand(compact);
        if (price) table[modelId] = price;
      }
      providers[providerId] = table;
    }
    snapshotCache = { revision: SNAPSHOT_REVISION, providers };
  }
  return snapshotCache;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function candidateIds(providerId: string, model: string): string[] {
  const normalized = model.trim().toLowerCase();
  const unqualified = normalized.includes("/")
    ? normalized.slice(normalized.lastIndexOf("/") + 1)
    : normalized;
  const withoutProvider = normalized.startsWith(`${providerId}/`)
    ? normalized.slice(providerId.length + 1)
    : normalized;
  return [...new Set([normalized, withoutProvider, unqualified])];
}

/**
 * The longest catalog id that `model` starts with.
 *
 * This is what resolves the ids the real logs carry: `claude-opus-5[1m]`, and
 * dated variants like `claude-sonnet-4-5-20250929`. Longest wins so
 * `claude-sonnet-4-6` is never swallowed by a shorter neighbour. models.dev
 * publishes no `[1m]` entries today, so a 1M-context id prices at its base
 * model's rate and says so with `prefix` rather than claiming `exact`.
 */
function longestPrefix(
  table: Record<string, ModelPrice>,
  model: string,
): ModelPrice | null {
  let best: string | null = null;
  for (const id of Object.keys(table)) {
    if (!model.startsWith(id)) continue;
    if (best === null || id.length > best.length) best = id;
  }
  return best === null ? null : table[best]!;
}

/** An id whose provider prefix was stripped, matched inside one table. */
function matchWithin(
  table: Record<string, ModelPrice>,
  ids: string[],
): { price: ModelPrice; status: PricingStatus } | null {
  for (const id of ids) {
    const exact = table[id];
    if (exact) return { price: exact, status: "exact" };
  }
  for (const id of ids) {
    const prefixed = longestPrefix(table, id);
    if (prefixed) return { price: prefixed, status: "prefix" };
  }
  return null;
}

export function resolveModel(
  catalog: PricingCatalog,
  provider: string,
  model: string | null,
): { price: ModelPrice | null; status: PricingStatus } {
  if (!model || !model.trim()) return { price: null, status: "unknown" };
  const providerId = normalizeProviderId(provider);
  const ids = candidateIds(providerId, model);

  const table = catalog.providers[providerId];
  if (table) {
    const match = matchWithin(table, ids);
    if (match) return match;
  }

  // Cross-provider fallback. Only accepted when exactly ONE provider claims
  // the id: two providers with the same model name and different prices is
  // precisely the case where a guess produces a wrong bill.
  const found: ModelPrice[] = [];
  for (const [candidateId, candidateTable] of Object.entries(
    catalog.providers,
  )) {
    if (candidateId === providerId) continue;
    const match = matchWithin(candidateTable, ids);
    if (match) found.push(match.price);
    if (found.length > 1) break;
  }
  if (found.length === 1) return { price: found[0]!, status: "alias" };

  return { price: null, status: "unknown" };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const ROW_ID = "models.dev";

interface CatalogRow {
  revision: string | null;
  fetched_at: string | null;
  data: string | null;
}

function readRow(db: Database): CatalogRow | undefined {
  return db
    .prepare<[string], CatalogRow>(
      "SELECT revision, fetched_at, data FROM pricing_catalog WHERE id = ?",
    )
    .get(ROW_ID);
}

function writeRow(
  db: Database,
  revision: string,
  fetchedAt: string,
  data: string,
): void {
  db.prepare(
    `INSERT INTO pricing_catalog (id, revision, fetched_at, data)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       revision = excluded.revision,
       fetched_at = excluded.fetched_at,
       data = excluded.data`,
  ).run(ROW_ID, revision, fetchedAt, data);
}

function parseRow(row: CatalogRow | undefined): PricingCatalog | null {
  if (!row?.data || !row.revision) return null;
  try {
    const providers = fromModelsDev(JSON.parse(row.data));
    return providers ? { revision: row.revision, providers } : null;
  } catch {
    return null;
  }
}

/**
 * The catalog to price with.
 *
 * Never throws and never returns null: a failed fetch falls back to the cached
 * row, and a missing row falls back to the bundled snapshot, so a caller
 * always has rates.
 */
export async function loadCatalog(
  db: Database,
  opts: LoadCatalogOptions,
): Promise<PricingCatalog> {
  const now = opts.now ?? Date.now;
  const cachedRow = readRow(db);
  const cached = parseRow(cachedRow);

  if (cached && cachedRow?.fetched_at) {
    const age = now() - Date.parse(cachedRow.fetched_at);
    if (Number.isFinite(age) && age < opts.refreshHours * 3_600_000) {
      return cached;
    }
  }

  const fetchImpl = opts.fetch;
  if (fetchImpl) {
    try {
      const response = await fetchImpl(MODELS_DEV_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (response.ok) {
        const raw: unknown = await response.json();
        const providers = fromModelsDev(raw);
        if (providers) {
          const fetchedAt = new Date(now()).toISOString();
          const revision = `models.dev@${fetchedAt.slice(0, 10)}`;
          try {
            writeRow(db, revision, fetchedAt, JSON.stringify(raw));
          } catch {
            // Caching is best-effort; the resolved catalog is still returned.
          }
          return { revision, providers };
        }
      }
    } catch {
      // Offline, rate-limited, or malformed. Fall through to what we have.
    }
  }

  return cached ?? bundledCatalog();
}
