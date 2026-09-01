// OpenCode (`~/.local/share/opencode/opencode.db`, or `$XDG_DATA_HOME`).
//
// Unlike Cursor, OpenCode records everything worth having: the cache split,
// the model, the provider, and its OWN cost figure, all inside the `data` JSON
// of the `message` table. The community scanner reads only the token counts;
// `modelID`, `providerID` and `cost` are read here too, because a logged cost
// outranks any catalog estimate.
//
// The query never selects `data` whole. Rows average ~7KB and reach multiple
// megabytes, and on a 50MB store that is the difference between a background
// pass and a stall; `json_extract` pulls the scalars in SQLite instead.
import { basename } from "node:path";
import {
  type DatabaseLogParser,
  type ParseContext,
  type ParsedLogTurn,
} from "./types.js";
import { openReadOnly, type ReadOnlyDatabase } from "./sqlite.js";

export const OPENCODE_PROVIDER = "opencode";

/**
 * `opencode-next.db` sits next to the real store and is stale. An
 * `endsWith("opencode.db")` test would exclude it only by the accident of the
 * hyphen, so the match is on the exact basename.
 */
export function isOpencodeStore(path: string): boolean {
  return basename(path) === "opencode.db";
}

const SCAN_SQL = `
  SELECT id,
         session_id                                    AS sessionId,
         time_created                                  AS timeCreated,
         time_updated                                  AS timeUpdated,
         json_extract(data, '$.time.completed')        AS completed,
         json_extract(data, '$.role')                  AS role,
         json_extract(data, '$.modelID')               AS model,
         json_extract(data, '$.providerID')            AS provider,
         json_extract(data, '$.cost')                  AS cost,
         json_extract(data, '$.tokens.input')          AS input,
         json_extract(data, '$.tokens.output')         AS output,
         json_extract(data, '$.tokens.reasoning')      AS reasoning,
         json_extract(data, '$.tokens.cache.read')     AS cacheRead,
         json_extract(data, '$.tokens.cache.write')    AS cacheWrite
    FROM message
   WHERE json_extract(data, '$.role') = 'assistant'
     AND (json_extract(data, '$.tokens.total')      > 0
       OR json_extract(data, '$.tokens.cache.read') > 0
       OR json_extract(data, '$.tokens.cache.write')> 0)
   ORDER BY time_created ASC, id ASC
`;

interface ScanRow {
  id: string;
  sessionId: string;
  timeCreated: number | null;
  timeUpdated: number | null;
  completed: number | null;
  model: string | null;
  provider: string | null;
  cost: number | null;
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

function tokens(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function tokensOrNull(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : null;
}

export function scanOpencodeDatabase(
  path: string,
  open: (file: string) => ReadOnlyDatabase = openReadOnly,
): ParsedLogTurn[] {
  const db = open(path);
  try {
    const rows = db.prepare<[], ScanRow>(SCAN_SQL).all();
    return rows.map((row) => ({
      provider: OPENCODE_PROVIDER,
      providerThreadId: row.sessionId,
      // `$.time.completed` is when the call actually finished; the row is
      // INSERTed at call start with zero tokens and UPDATEd on completion, so
      // `time_created` would stamp every turn at its request time.
      ts: row.completed ?? row.timeUpdated ?? row.timeCreated ?? 0,
      line: 0,
      dedupeKey: row.id,
      // OpenCode is an aggregator: `opencode` is the harness, `providerID` is
      // who actually billed. The two are joined into one qualified id so the
      // catalog can resolve `github-copilot/claude-opus-5` under the provider
      // that publishes its price, and so a rollup by model does not merge two
      // different bills for the same model name.
      model:
        row.model && row.provider
          ? `${row.provider}/${row.model}`
          : row.model,
      input: tokens(row.input),
      cacheRead: tokensOrNull(row.cacheRead),
      cacheWrite: tokensOrNull(row.cacheWrite),
      output: tokens(row.output),
      reasoning: tokens(row.reasoning),
      // OpenCode writes 0 for free and locally-hosted providers. That is a
      // real zero and is kept, not nulled into a catalog estimate.
      loggedCostUsd:
        typeof row.cost === "number" && Number.isFinite(row.cost)
          ? row.cost
          : null,
      isSidechain: false,
      agentId: null,
      cwd: null,
      skillNames: [],
      mcpNames: [],
    }));
  } finally {
    db.close();
  }
}

export const opencodeParser: DatabaseLogParser = {
  provider: OPENCODE_PROVIDER,
  matches: isOpencodeStore,
  parseLines: (_lines: string[], _ctx: ParseContext) => [],
  scanDatabase: (path) => scanOpencodeDatabase(path),
};
