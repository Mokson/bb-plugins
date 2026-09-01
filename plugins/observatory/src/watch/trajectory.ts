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
  const turnsStatement: Statement<[string], TurnRow> = deps.db.prepare(
    `SELECT turn_id, started_at, duration_ms, model_reported, model_requested,
            input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
            cost_usd, tool_calls, file_changes, compacted
       FROM obs_turn WHERE thread_id = ? ORDER BY seq_started ASC`,
  );
  const itemsStatement: Statement<[string], ItemRow> = deps.db.prepare(
    `SELECT turn_id, seq, kind, path, input_fingerprint
       FROM obs_item WHERE thread_id = ? ORDER BY seq ASC`,
  );

  return {
    render(threadId: string): string {
      const turns = turnsStatement.all(threadId);
      if (turns.length === 0) {
        return `no turns recorded for ${threadId}`;
      }
      const items = itemsStatement.all(threadId);
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

/**
 * Drop whole rows from the MIDDLE until the text fits. The head names the
 * thread and the tail carries the waste attribution, so a long run loses its
 * least informative rows rather than its conclusion.
 */
function clamp(lines: string[]): string {
  const rows = [...lines];
  let dropped = 0;
  while (rows.join("\n").length > TRAJECTORY_MAX_CHARS && rows.length > 4) {
    rows.splice(Math.floor(rows.length / 2), 1);
    dropped += 1;
  }
  if (dropped > 0) {
    rows.splice(Math.floor(rows.length / 2), 0, `... ${dropped} turns elided`);
    while (rows.join("\n").length > TRAJECTORY_MAX_CHARS && rows.length > 4) {
      rows.splice(Math.floor(rows.length / 2) + 1, 1);
    }
  }
  return rows.join("\n").slice(0, TRAJECTORY_MAX_CHARS);
}
