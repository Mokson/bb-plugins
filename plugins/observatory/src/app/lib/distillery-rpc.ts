// The distillery page's one data seam: load the queue, act on a draft.
//
// The page is a review loop, not a report, so this hook owns both halves. A
// caller learns three things - the query state, the current rows, and `act` -
// and gets the whole optimistic-update rule for free: an accepted, rejected or
// applied draft leaves the pending list, a snoozed one leaves it too (the
// server hides it until the snooze expires), and an edit replaces it in place.
//
// `kind: "absent"` is kept distinct from `kind: "error"` for the same reason
// the spend hook keeps them apart: a module that is not running must not
// render as an empty queue, because "nothing to review" is exactly the answer
// a reader would act on.
import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { isFixtureMode } from "@/lib/spend-rpc";
import type {
  ClusterView,
  CorrectionView,
  DistillAction,
  DistillStatus,
  distilleryContract,
  DraftEdit,
  DraftView,
  Rung,
} from "../../distillery/contract.js";

/** The line the page shows when the distillery rpc is not registered. */
export const ABSENT_MESSAGE = "distillery module not running";

/** The line the page shows when the queue is genuinely empty. */
export const EMPTY_MESSAGE = "queue empty, run bb observatory distill scan";

/**
 * Short labels for the gc.md mechanism ladder, mirroring `RUNGS` in
 * `src/distillery/contract.ts`.
 *
 * Held as plain data rather than imported: that module is a value module
 * (zod plus the SDK's `defineRpcContract`) and nothing under `src/app/`
 * pulls those into the panel bundle. The numbering is the spec's own, so a
 * rung shown here can be cited straight into a gc pass.
 */
export const RUNG_LABELS: Readonly<Record<Rung, string>> = {
  1: "prose (harness text)",
  2: "skill fix in the bundle source",
  3: "repo lint, check or CI rule",
  4: "template or packet change",
  5: "check in scripts/verify-stack.sh",
  6: "repo ops binding",
};

/** The weakest rung. gc.md 3a forbids re-adopting a recurring row here. */
const PROSE_RUNG: Rung = 1;

/**
 * The rung to argue for when a draft's own rung is prose, or null when it is
 * already mechanical.
 *
 * Rung 3 rather than 2: `applyBlockReason` in `src/distillery/apply.ts` names
 * 3, 5 and 6 as the mechanical carriers and 3 is the cheapest of them, so the
 * page's suggestion and the server's refusal say the same thing.
 */
export function strongerRung(
  rung: Rung | null,
): { rung: Rung; label: string } | null {
  if (rung !== PROSE_RUNG) return null;
  return { rung: 3, label: RUNG_LABELS[3] };
}

export type QueueRow = {
  draft: DraftView;
  cluster: ClusterView | null;
  evidence: CorrectionView[];
};

export type DistilleryData = {
  status: DistillStatus;
  rows: QueueRow[];
};

export type DistilleryQuery =
  | { kind: "loading" }
  | { kind: "absent" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: DistilleryData };

export type ActResult = {
  draft: DraftView;
  blocked: string | null;
  writtenPath: string | null;
};

/** Actions that take the draft out of the pending queue on success. */
const LEAVES_QUEUE: ReadonlySet<DistillAction> = new Set([
  "accept",
  "reject",
  "snooze",
  "apply",
]);

function isUnknownMethod(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "unknown_method"
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Cannot reach the Observatory plugin.";
}

type RpcCall = (
  method: string,
  input: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Apply one act result to the loaded data.
 *
 * Pure, so the keyboard path and the button path cannot diverge, and so the
 * counts move with the list rather than needing a second round trip.
 */
function applyAct(
  data: DistilleryData,
  action: DistillAction,
  result: ActResult,
): DistilleryData {
  if (result.blocked !== null) return data;
  const rows = LEAVES_QUEUE.has(action)
    ? data.rows.filter((row) => row.draft.id !== result.draft.id)
    : data.rows.map((row) =>
        row.draft.id === result.draft.id ? { ...row, draft: result.draft } : row,
      );
  const status = { ...data.status };
  if (LEAVES_QUEUE.has(action)) status.pending = Math.max(0, status.pending - 1);
  if (action === "accept") status.accepted += 1;
  if (action === "reject") status.rejected += 1;
  if (action === "apply") status.applied += 1;
  return { status, rows };
}

/**
 * The act a fixture-mode page performs instead of a round trip.
 *
 * Deliberately not the server's `applyBlockReason`: that lives beside the
 * filesystem writer, and nothing under `src/app/` may pull node built-ins into
 * the panel bundle. Fixture mode exercises the render, never the policy.
 */
function fixtureAct(
  draft: DraftView,
  action: DistillAction,
  edit?: DraftEdit,
): ActResult {
  const next: DraftView = {
    ...draft,
    ...(edit?.rule_text === undefined ? {} : { ruleText: edit.rule_text }),
    ...(edit?.patch_unified_diff === undefined
      ? {}
      : { patchUnifiedDiff: edit.patch_unified_diff }),
  };
  if (action === "apply") {
    const path = `~/.agents/improvements/fixture_${draft.id}.md`;
    return {
      draft: { ...next, state: "applied", appliedPath: path },
      blocked: null,
      writtenPath: path,
    };
  }
  // Snooze is the one action that leaves `state` alone; the server hides the
  // draft by date instead, and the page drops it from the list either way.
  const state =
    action === "accept"
      ? "accepted"
      : action === "reject"
        ? "rejected"
        : action === "edit"
          ? "edited"
          : next.state;
  return { draft: { ...next, state }, blocked: null, writtenPath: null };
}

/**
 * Load the pending queue and expose the one mutation over it.
 *
 * `act` resolves to the result rather than throwing, so a caller renders a
 * refusal (`blocked`) and a transport failure (`error`) the same one-line way.
 */
export function useDistillery(fixture: () => DistilleryData): {
  query: DistilleryQuery;
  act: (
    id: string,
    action: DistillAction,
    edit?: DraftEdit,
  ) => Promise<{ result: ActResult | null; error: string | null }>;
} {
  const rpc = useRpc<typeof distilleryContract>();
  const [query, setQuery] = useState<DistilleryQuery>({ kind: "loading" });
  // Read inside `act` without making the callback depend on the render's
  // snapshot; a double keypress would otherwise act against stale rows.
  const latest = useRef<DistilleryQuery>(query);
  latest.current = query;

  useEffect(() => {
    if (isFixtureMode()) {
      setQuery({ kind: "ready", data: fixture() });
      return;
    }

    let cancelled = false;
    setQuery({ kind: "loading" });

    void (async () => {
      const call = rpc.call as unknown as RpcCall;
      try {
        const [status, queued] = await Promise.all([
          call("observatory_distill_status", {}) as Promise<DistillStatus>,
          call("observatory_distill_queue", { state: "pending" }) as Promise<{
            rows: QueueRow[];
          }>,
        ]);
        if (cancelled) return;
        setQuery({ kind: "ready", data: { status, rows: queued.rows } });
      } catch (error) {
        if (cancelled) return;
        setQuery(
          isUnknownMethod(error)
            ? { kind: "absent" }
            : { kind: "error", message: messageOf(error) },
        );
      }
    })();

    return () => {
      cancelled = true;
    };
    // `fixture` is a module-level factory; re-running on its identity would
    // refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc]);

  const act = useCallback(
    async (id: string, action: DistillAction, edit?: DraftEdit) => {
      const current = latest.current;
      if (current.kind !== "ready") {
        return { result: null, error: ABSENT_MESSAGE };
      }
      if (isFixtureMode()) {
        const row = current.data.rows.find((entry) => entry.draft.id === id);
        if (row === undefined) return { result: null, error: `no draft ${id}` };
        const result = fixtureAct(row.draft, action, edit);
        setQuery((state) =>
          state.kind === "ready"
            ? { kind: "ready", data: applyAct(state.data, action, result) }
            : state,
        );
        return { result, error: result.blocked };
      }
      try {
        const call = rpc.call as unknown as RpcCall;
        const result = (await call("observatory_distill_act", {
          id,
          action,
          ...(edit === undefined ? {} : { edit }),
        })) as ActResult;
        setQuery((state) =>
          state.kind === "ready"
            ? { kind: "ready", data: applyAct(state.data, action, result) }
            : state,
        );
        return { result, error: result.blocked };
      } catch (error) {
        return { result: null, error: messageOf(error) };
      }
    },
    [rpc],
  );

  return { query, act };
}
