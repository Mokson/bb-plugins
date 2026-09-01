// The attention inbox: the panel's landing page.
//
// PRODUCT invariant 25 - open signals across every module, ranked, one
// evidence line each, and an explicit empty state rather than a blank page.
// The ranking and the wording live in `lib/inbox.ts` so this file is a
// renderer; what it owns is the four columns, the selection, and where each
// action goes.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import {
  FilterBox,
  Heading,
  Hero,
  KeyHelp,
  RowActions,
  WatchFrame,
} from "@/components/watch-common";
import { formatTime, formatUsd, UNKNOWN } from "@/lib/format";
import { matchesFilter, rankInboxRows, statusPhrase } from "@/lib/inbox";
import { useSpendQuery } from "@/lib/spend-rpc";
import { useWatchQuery } from "@/lib/watch-rpc";
import { usePanelKeys } from "@/lib/use-panel-keys";
import { fixtureInbox } from "@/fixtures/watch";
import { fixtureToday } from "@/fixtures/spend";
import { PANEL_PATH } from "./routes.js";
import { WATCH_SIGNAL_CHANNEL, type Inbox, type InboxAction, type InboxRow } from "../../watch/contract.js";
import type { SpendToday } from "../../spend/contract.js";

/**
 * Today's spend beside the watch counts.
 *
 * Four hero numbers, the page's whole allowance under PRODUCT invariant 34.
 * Spend comes from the spend module's own cheap method rather than being
 * recomputed here, so the header and the footer strip cannot disagree.
 */
function InboxHeader({ counts }: { counts: Inbox["counts"] }) {
  const today = useSpendQuery<SpendToday>(
    "observatory_spend_today",
    {},
    fixtureToday,
  );
  const spend =
    today.kind === "ready" ? formatUsd(today.data.spendUsd) : UNKNOWN;

  return (
    <div className="grid grid-cols-4 gap-6">
      <Hero label="today usd" value={spend} />
      <Hero label="watched" value={String(counts.watched)} />
      <Hero label="stalled" value={String(counts.stalled)} />
      <Hero label="queue" value={String(counts.queue)} />
    </div>
  );
}

function InboxTable({
  rows,
  selected,
  onSelect,
  onRun,
}: {
  rows: readonly InboxRow[];
  selected: number;
  onSelect: (index: number) => void;
  onRun: (row: InboxRow, action: InboxAction) => void;
}) {
  return (
    // Fixed layout, because the evidence line is the only column that may be
    // cut: in auto layout it wins the width fight and pushes the actions off
    // the right edge of a narrow panel, which hides the row's whole point.
    <table className="w-full table-fixed text-[13px]">
      <colgroup>
        <col className="w-[22%]" />
        <col className="w-[18%]" />
        <col />
        <col className="w-[13ch]" />
        <col className="w-[20ch]" />
      </colgroup>
      <thead>
        <tr className="text-[11px] text-muted-foreground">
          <th className="px-2 py-1 text-left font-normal">thread or source</th>
          <th className="px-2 py-1 text-left font-normal">status</th>
          <th className="px-2 py-1 text-left font-normal">evidence</th>
          <th className="px-2 py-1 text-left font-normal">opened</th>
          <th className="px-2 py-1 text-left font-normal">actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr
            key={row.id}
            aria-selected={index === selected}
            className={
              index === selected
                ? "border-t border-border bg-foreground/5"
                : "border-t border-border"
            }
            onMouseEnter={() => onSelect(index)}
          >
            <td className="h-6 truncate px-2 py-0">{row.title}</td>
            <td className="h-6 truncate px-2 py-0">{statusPhrase(row)}</td>
            <td className="h-6 truncate px-2 py-0 text-muted-foreground">
              {row.subtitle}
            </td>
            <td className="h-6 whitespace-nowrap px-2 py-0 tabular-nums">
              {formatTime(row.openedAt)}
            </td>
            <td className="h-6 whitespace-nowrap px-2 py-0">
              <RowActions
                actions={row.actions}
                label={row.title}
                onRun={(action) => onRun(row, action)}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function InboxPage() {
  const navigate = useBbNavigate();
  const [nonce, setNonce] = useState(0);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const filterRef = useRef<HTMLInputElement | null>(null);

  // A signal opening or closing changes this list, so re-read rather than
  // patching a row in place: the counts and the ranking are the server's.
  useRealtime(WATCH_SIGNAL_CHANNEL, () => setNonce((value) => value + 1));

  const query = useWatchQuery<Inbox>("observatory_inbox", {}, fixtureInbox, nonce);
  const data = query.kind === "ready" ? query.data : null;

  const rows = useMemo(() => {
    if (data === null) return [];
    return rankInboxRows(data.rows).filter((row) => matchesFilter(row, filter));
  }, [data, filter]);

  // A shrinking list must never leave the cursor past the end.
  useEffect(() => {
    setSelected((index) => Math.min(index, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  const run = useCallback(
    (row: InboxRow, action: InboxAction) => {
      if (action === "open" && row.threadId !== null) {
        navigate.toThread(row.threadId);
        return;
      }
      if (action === "review") {
        navigate.toPluginPanel(PANEL_PATH, { subPath: "distillery" });
      }
      // `steer` and `escalate` render disabled; they cannot reach here.
    },
    [navigate],
  );

  usePanelKeys(
    useCallback(
      (action) => {
        switch (action.kind) {
          case "navigate":
            navigate.toPluginPanel(PANEL_PATH, { subPath: action.route });
            return;
          case "focus-filter":
            filterRef.current?.focus();
            return;
          case "move":
            setSelected((index) =>
              rows.length === 0
                ? 0
                : Math.min(rows.length - 1, Math.max(0, index + action.delta)),
            );
            return;
          case "activate": {
            const row = rows[selected];
            if (row !== undefined) run(row, row.actions[0] ?? "open");
            return;
          }
          case "dismiss":
            filterRef.current?.blur();
            setHelpOpen(false);
            return;
          case "toggle-help":
            setHelpOpen((open) => !open);
        }
      },
      [navigate, rows, selected, run],
    ),
  );

  return (
    <section className="flex flex-col gap-3 py-4">
      <Heading>Inbox</Heading>
      <WatchFrame query={query}>
        {(inbox) => (
          <>
            <InboxHeader counts={inbox.counts} />
            <FilterBox
              value={filter}
              onChange={setFilter}
              inputRef={filterRef}
              placeholder="filter, / to focus"
            />
            {rows.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                {inbox.rows.length === 0
                  ? "Nothing is asking for attention."
                  : "No row matches this filter."}
              </p>
            ) : (
              <InboxTable
                rows={rows}
                selected={selected}
                onSelect={setSelected}
                onRun={run}
              />
            )}
            <KeyHelp open={helpOpen} />
          </>
        )}
      </WatchFrame>
    </section>
  );
}
