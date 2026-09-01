// `observatory_trajectory` — what the agent itself can read about its own run.
//
// Written for a model's context window, not a person's screen: fixed columns,
// no prose, and a hard 4096-character ceiling because that is the SDK's own
// truncation point and being truncated mid-row would corrupt the last line
// into something a model might read as data.
import type { Database, Statement } from "better-sqlite3";

export const TRAJECTORY_MAX_CHARS = 4096;
/** Identical fingerprints inside one turn that read as a loop. */
const LOOP_REPEATS = 3;
/**
 * Rows read per render. The output is capped at 4096 characters and a turn
 * line costs about thirty of them, so anything past a few hundred turns can
 * only ever be elided - and this runs on a SYNCHRONOUS database handle, where
 * an unbounded read of a long-lived thread blocks every other query.
 */
const TURN_CAP = 400;
/** Items read per render. Only their markers survive into the output. */
const ITEM_CAP = 4_000;

interface TurnRow {
  turn_id: string;
  started_at: string | null;
  duration_ms: number | null;
  model_reported: string | null;
  model_requested: string | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: number | null;
  tool_calls: number | null;
  file_changes: number | null;
  compacted: number | null;
}

interface ItemRow {
  turn_id: string | null;
  seq: number | null;
  kind: string | null;
  path: string | null;
  input_fingerprint: string | null;
}

export interface TrajectoryDeps {
  db: Database;
}

export interface Trajectory {
  render(threadId: string): string;
}

export function createTrajectory(deps: TrajectoryDeps): Trajectory {
  // Newest-first with a LIMIT, reversed in JS: the tail of a run is what a
  // model needs, and DESC is the direction the seq indexes already serve.
  const turnsStatement: Statement<[string, number], TurnRow> = deps.db.prepare(
    `SELECT turn_id, started_at, duration_ms, model_reported, model_requested,
            input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
            cost_usd, tool_calls, file_changes, compacted
       FROM obs_turn WHERE thread_id = ? ORDER BY seq_started DESC LIMIT ?`,
  );
  const itemsStatement: Statement<[string, number], ItemRow> = deps.db.prepare(
    `SELECT turn_id, seq, kind, path, input_fingerprint
       FROM obs_item WHERE thread_id = ? ORDER BY seq DESC LIMIT ?`,
  );

  return {
    render(threadId: string): string {
      const turns = turnsStatement.all(threadId, TURN_CAP).reverse();
      if (turns.length === 0) {
        return `no turns recorded for ${threadId}`;
      }
      const items = itemsStatement.all(threadId, ITEM_CAP).reverse();
      const byTurn = new Map<string, ItemRow[]>();
      for (const item of items) {
        if (!item.turn_id) continue;
        const bucket = byTurn.get(item.turn_id);
        if (bucket) bucket.push(item);
        else byTurn.set(item.turn_id, [item]);
      }

      let wastedTokens = 0;
      let totalTokens = 0;
      const lines: string[] = [`trajectory ${threadId}  turns ${turns.length}`];
      lines.push("#   tokens  tools  edits  markers");

      turns.forEach((turn, index) => {
        const tokens =
          (turn.input_tokens ?? 0) +
          (turn.cached_input_tokens ?? 0) +
          (turn.output_tokens ?? 0) +
          (turn.reasoning_tokens ?? 0);
        totalTokens += tokens;
        const markers = markersFor(turn, byTurn.get(turn.turn_id) ?? []);
        if (markers.length > 0) wastedTokens += tokens;
        lines.push(
          [
            String(index + 1).padEnd(3),
            `${Math.round(tokens / 1000)}k`.padStart(7),
            String(turn.tool_calls ?? 0).padStart(6),
            String(turn.file_changes ?? 0).padStart(6),
            markers.join(" "),
          ].join(" "),
        );
      });

      const share =
        totalTokens > 0 ? Math.round((wastedTokens / totalTokens) * 100) : 0;
      lines.push(
        `waste: ${Math.round(wastedTokens / 1000)}k of ${Math.round(
          totalTokens / 1000,
        )}k tokens (${share}%) sit in marked turns`,
      );

      return clamp(lines);
    },
  };
}

function markersFor(turn: TurnRow, items: readonly ItemRow[]): string[] {
  const markers: string[] = [];
  if (turn.compacted === 1) markers.push("CONTEXT RESET");

  const counts = new Map<string, number>();
  for (const item of items) {
    if (!item.input_fingerprint) continue;
    counts.set(
      item.input_fingerprint,
      (counts.get(item.input_fingerprint) ?? 0) + 1,
    );
  }
  if ([...counts.values()].some((count) => count >= LOOP_REPEATS)) {
    markers.push("LOOP");
  }

  const perPath = new Map<string, string[]>();
  for (const item of items) {
    if (!item.path) continue;
    if (item.kind !== "fileRead" && item.kind !== "fileChange") continue;
    const kinds = perPath.get(item.path) ?? [];
    kinds.push(item.kind === "fileRead" ? "R" : "E");
    perPath.set(item.path, kinds);
  }
  for (const kinds of perPath.values()) {
    if (kinds.join("").includes("RER")) {
      markers.push("OSCILLATION");
      break;
    }
  }
  return markers;
}

function noticeFor(dropped: number): string {
  return `... ${dropped} turns elided`;
}

/**
 * Drop whole rows from the MIDDLE until the text fits. The head names the
 * thread and the tail carries the waste attribution, so a long run loses its
 * least informative rows rather than its conclusion.
 *
 * The fit is tracked ARITHMETICALLY as rows leave, rather than re-joining
 * every remaining row on each pass as the old loop did, and every cut lands
 * on a row boundary, so the last line a model reads is never half a row of
 * data.
 */
function clamp(lines: string[]): string {
  const rows = [...lines];
  // Rendered length: every row plus the newline between each pair.
  let size = rows.reduce((total, row) => total + row.length, rows.length - 1);
  let dropped = 0;
  // The notice occupies a row of its own, so its cost is part of the fit.
  const budget = (): number =>
    TRAJECTORY_MAX_CHARS -
    (dropped > 0 ? noticeFor(dropped).length + 1 : 0);
  while (size > budget() && rows.length > 4) {
    const [cut] = rows.splice(Math.floor(rows.length / 2), 1);
    size -= (cut?.length ?? 0) + 1;
    dropped += 1;
  }
  if (dropped > 0) {
    rows.splice(Math.floor(rows.length / 2), 0, noticeFor(dropped));
  }

  const text = rows.join("\n");
  if (text.length <= TRAJECTORY_MAX_CHARS) return text;
  // Nothing left to elide (four rows or fewer, all of them long). Cut at the
  // last newline inside the ceiling rather than mid-row.
  const lastBreak = text.lastIndexOf("\n", TRAJECTORY_MAX_CHARS);
  return lastBreak > 0
    ? text.slice(0, lastBreak)
    : text.slice(0, TRAJECTORY_MAX_CHARS);
}
