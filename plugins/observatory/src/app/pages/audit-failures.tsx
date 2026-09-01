// The failure ledger: every error the runs produced, folded to a signature.
//
// A mute is the only state this page writes, and it always carries an expiry.
// A permanent mute is a finding deleted without saying so, which is why the
// control offers three durations and no "forever", and why a muted row stays
// on the page reading "muted until" rather than vanishing from it.
import { useCallback, useState } from "react";
import {
  Num,
  NumHead,
  QueryFrame,
  RangeSelect,
  SELECT_CLASS,
  TextHead,
} from "@/components/spend-common";
import { formatCount, formatTime } from "@/lib/format";
import { MUTE_DAYS, muteExpiry, type MuteDays } from "@/lib/audit";
import { callModule, useModuleQuery } from "@/lib/module-rpc";
import { fixtureAuditFailures } from "@/fixtures/context";
import type { SpendRange } from "../../spend/contract.js";
import type { AuditFailureRow } from "../../audit/contract.js";

function MuteControl({ row }: { row: AuditFailureRow }) {
  const [days, setDays] = useState<MuteDays>(7);
  const [note, setNote] = useState<string | null>(null);

  const mute = useCallback(async () => {
    setNote(null);
    try {
      const result = await callModule<{ signature: string; untilIso: string }>(
        "observatory_audit_failure_mute",
        { signature: row.signature, untilIso: muteExpiry(new Date(), days) },
      );
      setNote(`muted until ${formatTime(result.untilIso)}`);
    } catch (error) {
      setNote(error instanceof Error ? error.message : "mute unavailable");
    }
  }, [row.signature, days]);

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <label className="flex items-center gap-1 text-muted-foreground">
        mute for
        <select
          className={SELECT_CLASS}
          value={days}
          onChange={(event) =>
            setDays(Number(event.target.value) as MuteDays)
          }
        >
          {MUTE_DAYS.map((option) => (
            <option key={option} value={option}>
              {option}d
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={() => void mute()}
      >
        mute
      </button>
      {note === null ? null : (
        <span className="text-muted-foreground">{note}</span>
      )}
    </div>
  );
}

function FailureDetail({ row }: { row: AuditFailureRow }) {
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2">
      <h3 className="text-[13px] font-semibold">{row.signature}</h3>
      <p className="text-[13px] text-muted-foreground">{row.message}</p>
      <p className="text-[11px] text-muted-foreground">
        {row.muted
          ? `muted until ${formatTime(row.mutedUntil)}`
          : "not muted"}
      </p>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-[11px] text-muted-foreground">
            <TextHead>thread</TextHead>
          </tr>
        </thead>
        <tbody>
          {row.threads.map((thread) => (
            <tr key={thread} className="border-t border-border">
              <td className="h-6 px-2 py-0">{thread}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <MuteControl row={row} />
    </div>
  );
}

export function AuditFailures() {
  const [range, setRange] = useState<SpendRange>("7d");
  const [selected, setSelected] = useState<string | null>(null);
  const query = useModuleQuery<{ rows: AuditFailureRow[] }>(
    "observatory_audit_failures",
    { range, includeMuted: true },
    fixtureAuditFailures,
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <RangeSelect value={range} onChange={setRange} />
      </div>
      <QueryFrame query={query}>
        {(data) => {
          const row =
            data.rows.find((entry) => entry.signature === selected) ?? null;
          return (
            <>
              {data.rows.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  no failures in this range
                </p>
              ) : (
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-[11px] text-muted-foreground">
                      <TextHead>signature</TextHead>
                      <TextHead>category</TextHead>
                      <NumHead>count</NumHead>
                      <TextHead>first seen</TextHead>
                      <TextHead>last seen</TextHead>
                      <NumHead>threads</NumHead>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((entry) => (
                      <tr
                        key={entry.signature}
                        className="border-t border-border"
                      >
                        <td className="h-6 max-w-[280px] truncate px-2 py-0">
                          <button
                            type="button"
                            className="truncate text-left underline underline-offset-2"
                            onClick={() => setSelected(entry.signature)}
                          >
                            {entry.signature}
                          </button>
                        </td>
                        <td className="h-6 px-2 py-0 text-muted-foreground">
                          {entry.muted
                            ? `${entry.category}, muted`
                            : entry.category}
                        </td>
                        <Num>{formatCount(entry.count)}</Num>
                        <td className="h-6 px-2 py-0 tabular-nums">
                          {formatTime(entry.firstSeen)}
                        </td>
                        <td className="h-6 px-2 py-0 tabular-nums">
                          {formatTime(entry.lastSeen)}
                        </td>
                        <Num>{formatCount(entry.threads.length)}</Num>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {row === null ? null : <FailureDetail row={row} />}
            </>
          );
        }}
      </QueryFrame>
    </div>
  );
}
