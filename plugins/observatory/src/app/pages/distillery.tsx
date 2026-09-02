// The distillery review queue: one draft at a time, four verdicts, a keyboard.
//
// The page is a decision loop, not a report, so it shows exactly one draft.
// A list would invite skimming, and the thing being decided - is this the
// right carrier for this recurring failure - cannot be skimmed. The header
// carries the only aggregate a reviewer needs mid-loop (how much is left, and
// which signatures dominate); everything else is the draft in front of them.
//
// Density (PRODUCT invariant 34): one font at 11/13/16, weights 400 and 600,
// 24px rows, hairlines not boxes, radii at most 4px, no emojis, no colour as
// hierarchy. The one exception is the unified diff, which is monospace because
// a diff whose columns do not line up is a diff nobody can read.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTable, Heading } from "@/components/spend-common";
import {
  ABSENT_MESSAGE,
  EMPTY_MESSAGE,
  RUNG_LABELS,
  strongerRung,
  useDistillery,
  type QueueRow,
} from "@/lib/distillery-rpc";
import { fixtureDistillery } from "@/fixtures/distillery";
import type {
  DistillAction,
  DistillStatus,
  Rung,
} from "../../distillery/contract.js";

const ACTION_CLASS = "underline underline-offset-2";

/** The keyboard the loop is driven from. Rendered verbatim by the `?` sheet. */
const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ["j", "next draft"],
  ["k", "previous draft"],
  ["a", "accept"],
  ["e", "edit"],
  ["r", "reject"],
  ["s", "snooze"],
  ["?", "this sheet"],
];

/** One 11px label over its 13px value. The page's only field shape. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <div className="text-[13px]">{children}</div>
    </div>
  );
}

function CountsLine({ status }: { status: DistillStatus }) {
  return (
    <p className="text-[11px] text-muted-foreground tabular-nums">
      {status.pending} pending, {status.accepted} accepted, {status.applied}{" "}
      applied, {status.clusters} clusters
    </p>
  );
}

/**
 * The top cluster signatures, as a table so the counts stay in one column.
 *
 * These are the reason the queue exists: a signature that recurs across runs
 * is the case for spending a harness edit at all.
 */
function TopClusters({ status }: { status: DistillStatus }) {
  if (status.topClusters.length === 0) return null;
  return (
    <DataTable className="w-full text-[11px] text-muted-foreground">
      <tbody>
        {status.topClusters.map((cluster) => (
          <tr key={cluster.signature}>
            {/* The two fixed columns never wrap: `w-full` on the signature
                starves them otherwise, and a count broken over three lines
                takes the row off the 24px grid. */}
            <td className="h-6 whitespace-nowrap py-0 pr-3 text-right tabular-nums">
              {cluster.size}x / {cluster.runs} runs
            </td>
            <td className="h-6 whitespace-nowrap py-0 pr-3">
              {cluster.cause_class ?? "untagged"}
            </td>
            {/* The signature absorbs the remaining width and truncates, so one
                long one cannot reflow the whole strip. */}
            <td
              className="h-6 w-full max-w-0 truncate py-0"
              title={cluster.signature}
            >
              {cluster.signature}
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

function ShortcutSheet() {
  return (
    <DataTable className="w-full text-[11px] text-muted-foreground">
      <tbody>
        {SHORTCUTS.map(([key, meaning]) => (
          <tr key={key}>
            <td className="h-6 w-8 py-0">{key}</td>
            <td className="h-6 py-0">{meaning}</td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

/**
 * The rung line.
 *
 * A prose rung is the one thing on this page that argues back: gc.md forbids
 * re-adopting a recurring failure as more harness text, so the page names the
 * carrier to reclassify to before the reviewer accepts.
 */
function RungLine({ rung }: { rung: Rung | null }) {
  if (rung === null) {
    return (
      <Field label="rung">
        <span className="text-muted-foreground">unclassified</span>
      </Field>
    );
  }
  const stronger = strongerRung(rung);
  return (
    <Field label="rung">
      {rung} {RUNG_LABELS[rung]}
      {stronger === null ? null : (
        <span className="text-muted-foreground">
          {" "}
          - prose is the weakest carrier; reclassify to rung {stronger.rung},{" "}
          {stronger.label}
        </span>
      )}
    </Field>
  );
}

/** The proposed change: a unified diff, or the rule text when there is none. */
function Proposal({
  row,
  editing,
  text,
  onText,
}: {
  row: QueueRow;
  editing: boolean;
  text: string;
  onText: (next: string) => void;
}) {
  const isPatch = row.draft.patchUnifiedDiff !== null;
  const label = isPatch ? "proposed patch" : "rule text";
  if (editing) {
    return (
      <Field label={`${label} (editing)`}>
        <textarea
          aria-label={`Edit ${label}`}
          className="h-40 w-full rounded-[4px] border border-border bg-transparent p-2 font-mono text-[11px]"
          value={text}
          onChange={(event) => onText(event.target.value)}
        />
      </Field>
    );
  }
  const body = isPatch ? row.draft.patchUnifiedDiff : row.draft.ruleText;
  return (
    <Field label={label}>
      {body === null ? (
        <span className="text-muted-foreground">
          neither a patch nor rule text
        </span>
      ) : (
        <pre className="overflow-x-auto whitespace-pre font-mono text-[11px] leading-6">
          {body}
        </pre>
      )}
    </Field>
  );
}

/** The evidence behind the draft: what happened, and what the human said. */
function Evidence({ row }: { row: QueueRow }) {
  const first = row.evidence[0];
  return (
    <>
      <Field label="before">
        {first === undefined ? (
          <span className="text-muted-foreground">no cited evidence</span>
        ) : (
          first.preview
        )}
      </Field>
      <Field label="correction">
        {first === undefined ? (
          <span className="text-muted-foreground">--</span>
        ) : (
          <>
            {first.signature}
            <span className="text-muted-foreground">
              {" "}
              [{first.source}, {first.causeClass ?? "untagged"}]
            </span>
          </>
        )}
      </Field>
    </>
  );
}

function DraftCard({
  row,
  position,
  total,
  editing,
  text,
  onText,
}: {
  row: QueueRow;
  position: number;
  total: number;
  editing: boolean;
  text: string;
  onText: (next: string) => void;
}) {
  const { draft, cluster } = row;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted-foreground tabular-nums">
        {draft.id} - {position} of {total} - {draft.state} -{" "}
        {draft.homeFile ?? "no home file"}
      </p>
      <Evidence row={row} />
      <Proposal row={row} editing={editing} text={text} onText={onText} />
      <RungLine rung={draft.rung} />
      <p className="text-[11px] text-muted-foreground tabular-nums">
        evidence{" "}
        {draft.evidenceIds.length === 0
          ? "none"
          : draft.evidenceIds.join(", ")}{" "}
        - recurrence {draft.recurrence}
        {cluster === null
          ? ""
          : ` - cluster ${cluster.size}x across ${cluster.runs} runs`}
      </p>
    </div>
  );
}

function Actions({
  editing,
  onAct,
  onEdit,
  onSave,
  onCancel,
}: {
  editing: boolean;
  onAct: (action: DistillAction) => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  if (editing) {
    return (
      <div className="flex items-center gap-3 text-[11px]">
        <button type="button" className={ACTION_CLASS} onClick={onSave}>
          save
        </button>
        <button type="button" className={ACTION_CLASS} onClick={onCancel}>
          cancel
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-3 text-[11px]">
      <button
        type="button"
        className={ACTION_CLASS}
        onClick={() => onAct("accept")}
      >
        accept
      </button>
      <button type="button" className={ACTION_CLASS} onClick={onEdit}>
        edit
      </button>
      <button
        type="button"
        className={ACTION_CLASS}
        onClick={() => onAct("reject")}
      >
        reject
      </button>
      <button
        type="button"
        className={ACTION_CLASS}
        onClick={() => onAct("snooze")}
      >
        snooze
      </button>
      <button
        type="button"
        className={ACTION_CLASS}
        onClick={() => onAct("apply")}
      >
        apply
      </button>
    </div>
  );
}

/** The text an edit starts from: the patch when there is one, else the rule. */
function proposalText(row: QueueRow): string {
  return row.draft.patchUnifiedDiff ?? row.draft.ruleText ?? "";
}

export function Distillery() {
  const { query, act } = useDistillery(fixtureDistillery);
  const [index, setIndex] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const rows = query.kind === "ready" ? query.data.rows : [];
  // The list shrinks under the cursor as drafts are decided, so the position
  // is clamped at read time rather than corrected in every handler.
  const position = rows.length === 0 ? 0 : Math.min(index, rows.length - 1);
  const row = rows[position];
  const editing = row !== undefined && editingId === row.draft.id;

  const runAct = useCallback(
    async (action: DistillAction, target: QueueRow, body?: string) => {
      setNote(null);
      // An edit replaces whichever carrier the draft already uses; offering
      // the other one would silently change what the draft proposes.
      const edit =
        body === undefined
          ? undefined
          : target.draft.patchUnifiedDiff !== null
            ? { patch_unified_diff: body }
            : { rule_text: body };
      const { result, error } = await act(target.draft.id, action, edit);
      if (error !== null) {
        setNote(error);
        return;
      }
      setEditingId(null);
      if (action === "apply" && result?.writtenPath) {
        setNote(`wrote ${result.writtenPath}`);
      }
    },
    [act],
  );

  const startEdit = useCallback(() => {
    if (row === undefined) return;
    setEditingId(row.draft.id);
    setText(proposalText(row));
  }, [row]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      // While a textarea or input holds focus the keys are text, not commands.
      if (tag === "TEXTAREA" || tag === "INPUT") {
        if (event.key === "Escape") setEditingId(null);
        return;
      }
      if (event.key === "?") {
        setShowHelp((current) => !current);
        return;
      }
      if (event.key === "Escape") {
        setShowHelp(false);
        setEditingId(null);
        return;
      }
      if (event.key === "j" || event.key === "k") {
        // A note describes the draft it came from, so it never outlives it.
        setNote(null);
        const last = Math.max(0, rows.length - 1);
        setIndex((current) =>
          event.key === "j"
            ? Math.min(current + 1, last)
            : Math.max(0, current - 1),
        );
        return;
      }
      if (row === undefined) return;
      if (event.key === "e") {
        startEdit();
        return;
      }
      const action: DistillAction | null =
        event.key === "a"
          ? "accept"
          : event.key === "r"
            ? "reject"
            : event.key === "s"
              ? "snooze"
              : null;
      if (action === null) return;
      void runAct(action, row);
    }

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [row, rows.length, runAct, startEdit]);

  if (query.kind === "loading") {
    return (
      <section className="flex flex-col gap-3 py-4">
        <Heading>Distillery</Heading>
        <Skeleton className="h-6 w-64 rounded-[4px]" />
        <Skeleton className="h-56 w-full rounded-[4px]" />
      </section>
    );
  }
  if (query.kind === "absent" || query.kind === "error") {
    return (
      <section className="flex flex-col gap-3 py-4">
        <Heading>Distillery</Heading>
        <p className="text-[13px] text-muted-foreground">
          {query.kind === "absent" ? ABSENT_MESSAGE : query.message}
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading>Distillery</Heading>
        <button
          type="button"
          className={`${ACTION_CLASS} text-[11px]`}
          aria-expanded={showHelp}
          onClick={() => setShowHelp((current) => !current)}
        >
          shortcuts
        </button>
      </div>
      <CountsLine status={query.data.status} />
      <TopClusters status={query.data.status} />
      {showHelp ? <ShortcutSheet /> : null}
      <Separator />
      {row === undefined ? (
        <p className="text-[13px] text-muted-foreground">{EMPTY_MESSAGE}</p>
      ) : (
        <>
          <DraftCard
            row={row}
            position={position + 1}
            total={rows.length}
            editing={editing}
            text={text}
            onText={setText}
          />
          <Actions
            editing={editing}
            onAct={(action) => void runAct(action, row)}
            onEdit={startEdit}
            onSave={() => void runAct("edit", row, text)}
            onCancel={() => setEditingId(null)}
          />
        </>
      )}
      {note === null ? null : (
        <p className="text-[11px] text-muted-foreground">{note}</p>
      )}
    </section>
  );
}
