// The context module's one assembly point: scan, estimate, analyze, persist.
//
// The view is always computed from a fresh scan — reading four small files is
// cheaper than explaining a stale composition bar — and the snapshot ROW is
// what persists, so composition can be compared across days and the
// calibration factor has a history. A scan inside the reuse window updates
// that day's row rather than adding one per panel render.
import type { Database } from "better-sqlite3";
import type { ObservatoryStore } from "../core/store.js";
import type {
  ContextBlock,
  ContextComposition,
  ContextSnapshot,
  ContextSurface,
  ContextThreadView,
  ContextView,
} from "./contract.js";
import { findDuplicates, usedSkillNames } from "./duplicates.js";
import { calibrate, estimateTokens, newestProvider } from "./estimate.js";
import {
  blockHash,
  scanSurfaces,
  type PluginToolDescriptor,
  type ScannedBlock,
} from "./scan.js";

/** How far back a session still counts as evidence that a skill is alive. */
export const USAGE_WINDOW_DAYS = 30;

/** A second scan of the same cwd inside this window rewrites its row. */
export const SNAPSHOT_REUSE_MINUTES = 60;

const SURFACE_ORDER: readonly ContextSurface[] = [
  "instruction",
  "skill",
  "mcp",
  "plugin-tool",
];

/** Item kinds whose result text lands in the thread's history. */
const TOOL_ITEM_KINDS = [
  "toolCall",
  "commandExecution",
  "webSearch",
  "webFetch",
  "search",
  "fileRead",
];

export interface ContextDeps {
  db: Database;
  store: ObservatoryStore;
  /** Overridable so a test can point the global surfaces at a fixture. */
  home?: string;
  pluginTools: readonly PluginToolDescriptor[];
  now?(): Date;
}

export interface SnapshotInput {
  cwd?: string | undefined;
  projectId?: string | undefined;
  refresh?: boolean | undefined;
}

interface AnalyzedBlock extends ScannedBlock {
  estTokens: number;
  hash: string;
}

function composition(blocks: readonly AnalyzedBlock[]): ContextComposition[] {
  const total = blocks.reduce((sum, block) => sum + block.estTokens, 0);
  return SURFACE_ORDER.map((surface) => {
    const estTokens = blocks
      .filter((block) => block.surface === surface)
      .reduce((sum, block) => sum + block.estTokens, 0);
    return { surface, estTokens, share: total > 0 ? estTokens / total : 0 };
  });
}

/**
 * Resolve the cwd to scan. A project id alone is answered from the newest
 * thread that carried one, which is the only place the mapping exists: bb
 * gives a plugin no project-to-directory lookup.
 */
function resolveCwd(db: Database, input: SnapshotInput): string {
  if (input.cwd) return input.cwd;
  if (input.projectId) {
    const row = db
      .prepare<[string], { cwd: string | null }>(
        `SELECT cwd FROM obs_thread
          WHERE project_id = ? AND cwd IS NOT NULL
          ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 1`,
      )
      .get(input.projectId);
    if (row?.cwd) return row.cwd;
  }
  return process.cwd();
}

function reusableSnapshotId(
  db: Database,
  cwd: string,
  cutoffIso: string,
): number | null {
  const row = db
    .prepare<[string, string], { id: number }>(
      `SELECT id FROM obs_ctx_snapshot
        WHERE cwd = ? AND taken_at >= ? ORDER BY taken_at DESC LIMIT 1`,
    )
    .get(cwd, cutoffIso);
  return row?.id ?? null;
}

/**
 * Scan `cwd`, price every block, mark duplicates and dead skills, persist.
 */
export function takeSnapshot(
  deps: ContextDeps,
  input: SnapshotInput = {},
): ContextView {
  const { db, store } = deps;
  const now = deps.now?.() ?? new Date();
  const cwd = resolveCwd(db, input);
  const sinceMs = now.getTime() - USAGE_WINDOW_DAYS * 86_400_000;
  const sinceIso = new Date(sinceMs).toISOString();

  const scanned = scanSurfaces({
    cwd,
    ...(deps.home === undefined ? {} : { home: deps.home }),
    pluginTools: deps.pluginTools,
  });
  const rawTotal = scanned.reduce(
    (sum, block) => sum + estimateTokens(block.text),
    0,
  );
  const provider = newestProvider(db);
  const calibration = calibrate({
    db,
    provider,
    rawEstimate: rawTotal,
    sinceMs,
    getMeta: (key) => store.getMeta(key),
    setMeta: (key, value) => store.setMeta(key, value),
  });
  const factor = calibration.factor ?? 1;
  const analyzed: AnalyzedBlock[] = scanned.map((block) => ({
    ...block,
    estTokens: estimateTokens(block.text, factor),
    hash: blockHash(block.text),
  }));

  const duplicates = findDuplicates(analyzed);
  const duplicateOf = new Map<string, string>();
  for (const pair of duplicates) {
    if (!duplicateOf.has(pair.a)) duplicateOf.set(pair.a, pair.b);
    if (!duplicateOf.has(pair.b)) duplicateOf.set(pair.b, pair.a);
  }

  const used = usedSkillNames(db, sinceIso, sinceMs);
  const blocks: ContextBlock[] = analyzed.map((block) => ({
    surface: block.surface,
    path: block.path,
    name: block.name,
    bytes: Buffer.byteLength(block.text, "utf8"),
    estTokens: block.estTokens,
    hash: block.hash,
    duplicateOf: duplicateOf.get(block.name) ?? null,
    dead: block.surface === "skill" && !used.has(block.name.toLowerCase()),
  }));
  const totalEstTokens = blocks.reduce((sum, block) => sum + block.estTokens, 0);

  const takenAt = now.toISOString();
  const cutoff = new Date(
    now.getTime() - SNAPSHOT_REUSE_MINUTES * 60_000,
  ).toISOString();
  const reuse = input.refresh ? null : reusableSnapshotId(db, cwd, cutoff);
  const projectId = input.projectId ?? null;
  let id: number;
  if (reuse === null) {
    const result = db
      .prepare(
        `INSERT INTO obs_ctx_snapshot
           (project_id, cwd, taken_at, provider, total_est_tokens,
            calibration_factor, calibration_error)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        cwd,
        takenAt,
        provider,
        totalEstTokens,
        calibration.factor,
        calibration.error,
      );
    id = Number(result.lastInsertRowid);
  } else {
    id = reuse;
    db.prepare(
      `UPDATE obs_ctx_snapshot
          SET taken_at = ?, provider = ?, total_est_tokens = ?,
              calibration_factor = ?, calibration_error = ?
        WHERE id = ?`,
    ).run(
      takenAt,
      provider,
      totalEstTokens,
      calibration.factor,
      calibration.error,
      id,
    );
    db.prepare("DELETE FROM obs_ctx_block WHERE snapshot_id = ?").run(id);
  }
  const insertBlock = db.prepare(
    `INSERT INTO obs_ctx_block
       (snapshot_id, surface, path, name, bytes, est_tokens, hash,
        duplicate_of, dead)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const block of blocks) {
      insertBlock.run(
        id,
        block.surface,
        block.path,
        block.name,
        block.bytes,
        block.estTokens,
        block.hash,
        block.duplicateOf,
        block.dead ? 1 : 0,
      );
    }
  })();

  const snapshot: ContextSnapshot = {
    id,
    projectId,
    cwd,
    takenAt,
    provider,
    totalEstTokens,
    calibrationFactor: calibration.factor,
    calibrationError: calibration.error,
  };
  return {
    snapshot,
    blocks,
    duplicates,
    dead: blocks
      .filter((block) => block.dead)
      .map((block) => ({
        name: block.name,
        path: block.path,
        bytes: block.bytes,
      })),
    composition: composition(analyzed),
  };
}

/** What one thread's window is made of, and what compaction could give back. */
export function contextThread(
  deps: ContextDeps,
  threadId: string,
): ContextThreadView {
  const { db } = deps;
  const turn = db
    .prepare<[string], { context_used: number | null; context_window: number | null }>(
      `SELECT context_used, context_window FROM obs_turn
        WHERE thread_id = ? AND context_used IS NOT NULL
        ORDER BY COALESCE(completed_at, started_at) DESC LIMIT 1`,
    )
    .get(threadId);
  const thread = db
    .prepare<[string], { cwd: string | null }>(
      "SELECT cwd FROM obs_thread WHERE thread_id = ?",
    )
    .get(threadId);
  const snapshotRow = thread?.cwd
    ? db
        .prepare<[string], { id: number; total_est_tokens: number }>(
          `SELECT id, total_est_tokens FROM obs_ctx_snapshot
            WHERE cwd = ? ORDER BY taken_at DESC LIMIT 1`,
        )
        .get(thread.cwd)
    : undefined;
  const counts = db
    .prepare<string[], { total: number; tools: number | null }>(
      // The kind list is inlined rather than bound: it is a constant in this
      // file, and binding it would make the statement's arity depend on it.
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN kind IN (${TOOL_ITEM_KINDS.map(
                (kind) => `'${kind}'`,
              ).join(", ")}) THEN 1 ELSE 0 END) AS tools
         FROM obs_item WHERE thread_id = ?`,
    )
    .get(threadId) ?? { total: 0, tools: 0 };

  const contextUsed = turn?.context_used ?? null;
  const contextWindow = turn?.context_window ?? null;
  const prefix = snapshotRow?.total_est_tokens ?? null;
  // History is what the window holds beyond the prefix. With no snapshot for
  // this thread's cwd there is no prefix to subtract, and a share computed
  // without one would be the whole window every time.
  const historyTokens =
    contextUsed !== null && prefix !== null
      ? Math.max(0, contextUsed - prefix)
      : null;
  const historyShare =
    historyTokens !== null && contextUsed && contextUsed > 0
      ? historyTokens / contextUsed
      : null;
  const toolResultShare =
    counts.total > 0 ? (counts.tools ?? 0) / counts.total : null;
  return {
    threadId,
    contextUsed,
    contextWindow,
    historyShare,
    toolResultShare,
    // Compaction reclaims history, and the part of history worth reclaiming
    // is the tool output: it is the bulk of it and the least re-read.
    compactionEstimateTokens:
      historyTokens !== null && toolResultShare !== null
        ? Math.round(historyTokens * toolResultShare)
        : null,
    snapshotId: snapshotRow?.id ?? null,
  };
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

export function formatContext(view: ContextView): string {
  const { snapshot } = view;
  const lines = [
    `${snapshot.cwd}  ${snapshot.takenAt}`,
    `prefix ${snapshot.totalEstTokens}e tokens  provider ${
      snapshot.provider ?? "n/a"
    }  calibration ${
      snapshot.calibrationFactor === null
        ? "n/a"
        : snapshot.calibrationFactor.toFixed(3)
    } (error ${pct(snapshot.calibrationError)})`,
    "",
  ];
  for (const entry of view.composition) {
    lines.push(
      `${entry.surface.padEnd(12)} ${String(entry.estTokens).padStart(
        8,
      )}e  ${pct(entry.share).padStart(7)}`,
    );
  }
  if (view.duplicates.length > 0) {
    lines.push("", "duplicates");
    for (const pair of view.duplicates.slice(0, 10)) {
      lines.push(
        `  ${pct(pair.overlap).padStart(7)}  ${pair.recoverableTokens
          .toString()
          .padStart(6)}e  ${pair.a} <-> ${pair.b}`,
      );
    }
  }
  if (view.dead.length > 0) {
    lines.push("", `dead skills (${view.dead.length})`);
    for (const skill of view.dead.slice(0, 20)) {
      lines.push(`  ${String(skill.bytes).padStart(6)}B  ${skill.name}`);
    }
  }
  return lines.join("\n");
}

/** The block table behind the composition bar, biggest first. */
export function formatSurfaces(view: ContextView): string {
  const lines = [
    `${"surface".padEnd(12)} ${"est".padStart(8)} ${"bytes".padStart(
      8,
    )}  flags  name`,
  ];
  for (const block of [...view.blocks].sort(
    (a, b) => b.estTokens - a.estTokens,
  )) {
    const flags = [
      block.duplicateOf ? "dup" : "",
      block.dead ? "dead" : "",
    ]
      .filter(Boolean)
      .join(",");
    lines.push(
      `${block.surface.padEnd(12)} ${String(block.estTokens).padStart(
        8,
      )} ${String(block.bytes).padStart(8)}  ${flags.padEnd(6)} ${block.name}`,
    );
  }
  return lines.join("\n");
}

export function formatThreadContext(view: ContextThreadView): string {
  return [
    `thread ${view.threadId}`,
    `context ${view.contextUsed ?? "n/a"} / ${view.contextWindow ?? "n/a"}`,
    `history share ${pct(view.historyShare)}  tool-result share ${pct(
      view.toolResultShare,
    )}`,
    `compaction estimate ${
      view.compactionEstimateTokens === null
        ? "n/a"
        : `${view.compactionEstimateTokens}e tokens`
    }`,
  ].join("\n");
}
