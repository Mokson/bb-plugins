// The failure ledger: the same thing going wrong, counted.
//
// A failure is only useful once it has an identity that survives the details
// that differ every time — the path, the request id, the retry number. That
// identity is the signature, and everything else here (counts, first and last
// seen, the mute) hangs off it.
import type { Database } from "better-sqlite3";
import type { ObservatoryStore } from "../core/store.js";
import type { SpendRange } from "../spend/contract.js";
import { rangeStart } from "../spend/rollup.js";
import type { AuditFailureRow } from "./contract.js";

/** Longest normalized message kept in a signature. */
const MESSAGE_CAP = 120;

/**
 * Strip everything that varies between two instances of the same failure.
 *
 * Order is load-bearing: paths go first because a path can contain a hex id,
 * and bare digits go last because every earlier rule would otherwise eat their
 * context.
 */
export function normalizeMessage(message: string): string {
  return message
    .replace(/(?:[A-Za-z]:)?[\\/][\w.\-\\/]+/gu, "<path>")
    .replace(/\b[0-9a-f]{8,}\b/giu, "<id>")
    .replace(/\b[A-Z]{2,6}-\d+\b/gu, "<id>")
    .replace(/\d+/gu, "N")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()
    .slice(0, MESSAGE_CAP);
}

/** Category plus normalized message. Stable across ids, paths and counts. */
export function failureSignature(category: string, message: string): string {
  return `${category}|${normalizeMessage(message)}`;
}

/** Meta key holding one signature's mute expiry. */
export function muteKey(signature: string): string {
  return `audit:mute:${signature}`;
}

export function muteFailure(
  store: ObservatoryStore,
  signature: string,
  untilIso: string,
): void {
  store.setMeta(muteKey(signature), untilIso);
}

/**
 * A mute is a promise to look again, so it always carries an expiry: past it
 * the signature is loud once more without anyone having to remember to unmute.
 */
export function muteState(
  store: ObservatoryStore,
  signature: string,
  nowIso: string,
): { muted: boolean; mutedUntil: string | null } {
  const until = store.getMeta(muteKey(signature));
  if (!until) return { muted: false, mutedUntil: null };
  return { muted: until > nowIso, mutedUntil: until };
}

export interface FailuresQuery {
  range: SpendRange;
  includeMuted?: boolean | undefined;
  threadId?: string | undefined;
}

export interface FailuresDeps {
  db: Database;
  store: ObservatoryStore;
  now?(): Date;
}

interface RawFailure {
  category: string | null;
  message: string | null;
  thread_id: string;
  at: string | null;
}

/**
 * Failures from both halves of the ledger: turns that ended in a provider
 * error, and items that reported one. They are folded into one list because a
 * person triaging asks "what keeps breaking", not "which table said so".
 */
function rawFailures(
  db: Database,
  since: string,
  threadId: string | undefined,
): RawFailure[] {
  const clause = threadId ? " AND thread_id = ?" : "";
  const args = threadId ? [since, threadId] : [since];
  const turns = db
    .prepare<unknown[], RawFailure>(
      `SELECT error_category AS category,
              COALESCE(model_reported, model_requested, '') AS message,
              thread_id, COALESCE(completed_at, started_at) AS at
         FROM obs_turn
        WHERE error_category IS NOT NULL
          AND COALESCE(completed_at, started_at, '') >= ?${clause}`,
    )
    .all(...args);
  const items = db
    .prepare<unknown[], RawFailure>(
      `SELECT COALESCE(error, 'item-error') AS category,
              COALESCE(kind, '') || ':' || COALESCE(name, '') AS message,
              thread_id, COALESCE(completed_at, started_at) AS at
         FROM obs_item
        WHERE error IS NOT NULL
          AND COALESCE(completed_at, started_at, '') >= ?${clause}`,
    )
    .all(...args);
  return [...turns, ...items];
}

export function failureRows(
  deps: FailuresDeps,
  query: FailuresQuery,
): AuditFailureRow[] {
  const now = deps.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const since = rangeStart(query.range, now.getTime());
  const grouped = new Map<
    string,
    {
      category: string;
      message: string;
      count: number;
      firstSeen: string;
      lastSeen: string;
      threads: Set<string>;
    }
  >();
  for (const row of rawFailures(deps.db, since, query.threadId)) {
    const category = row.category ?? "unknown";
    const message = normalizeMessage(row.message ?? "");
    const signature = failureSignature(category, row.message ?? "");
    const at = row.at ?? nowIso;
    const existing = grouped.get(signature);
    if (existing) {
      existing.count += 1;
      existing.threads.add(row.thread_id);
      if (at < existing.firstSeen) existing.firstSeen = at;
      if (at > existing.lastSeen) existing.lastSeen = at;
      continue;
    }
    grouped.set(signature, {
      category,
      message,
      count: 1,
      firstSeen: at,
      lastSeen: at,
      threads: new Set([row.thread_id]),
    });
  }
  const rows: AuditFailureRow[] = [];
  for (const [signature, entry] of grouped) {
    const mute = muteState(deps.store, signature, nowIso);
    if (mute.muted && !query.includeMuted) continue;
    rows.push({
      signature,
      category: entry.category,
      message: entry.message,
      count: entry.count,
      firstSeen: entry.firstSeen,
      lastSeen: entry.lastSeen,
      threads: [...entry.threads].sort(),
      muted: mute.muted,
      mutedUntil: mute.mutedUntil,
    });
  }
  return rows.sort(
    (a, b) => b.count - a.count || a.signature.localeCompare(b.signature),
  );
}

export function formatFailures(rows: readonly AuditFailureRow[]): string {
  if (rows.length === 0) return "no failures in range";
  const lines = [
    `${"count".padStart(6)} ${"threads".padStart(7)} ${"last seen".padEnd(
      26,
    )} signature`,
  ];
  for (const row of rows) {
    lines.push(
      `${String(row.count).padStart(6)} ${String(row.threads.length).padStart(
        7,
      )} ${row.lastSeen.padEnd(26)} ${row.signature}${row.muted ? "  (muted)" : ""}`,
    );
  }
  return lines.join("\n");
}
