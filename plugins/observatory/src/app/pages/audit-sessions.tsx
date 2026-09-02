// The audit sessions list and one session's detail.
//
// A session is judged against the last seven days of sessions, not against an
// absolute budget: "this run cost $24" says nothing without "the median run
// costs $9". So the detail page is a metric-beside-median table, and the two
// numbers that decide whether a run can be trusted - did it verify anything,
// and what did it edit without verifying - sit above it rather than inside a
// findings list a reader has to scroll to.
import { useCallback, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import {
  Heading,
  Hero,
  HeroRow,
  Num,
  NumHead,
  QueryFrame,
  RangeSelect,
  TextHead,
} from "@/components/spend-common";
import {
  formatCount,
  formatDelta,
  formatTime,
  formatTokens,
  formatUsd,
  UNKNOWN,
} from "@/lib/format";
import { verificationVerdict } from "@/lib/audit";
import { callModule, useModuleQuery } from "@/lib/module-rpc";
import { fixtureAuditSession, fixtureAuditSessions } from "@/fixtures/context";
import { PANEL_PATH } from "./routes.js";
import type { SpendRange } from "../../spend/contract.js";
import type {
  AuditExport,
  AuditSessionRow,
  AuditSessionView,
} from "../../audit/contract.js";

/** Whether a metric is a dollar amount, so the table can render it as one. */
function formatMetric(metric: string, value: number | null): string {
  if (metric.includes("usd")) return formatUsd(value);
  if (metric.includes("token")) return formatTokens(value);
  return formatCount(value);
}

function SessionTable({
  rows,
  onOpen,
}: {
  rows: readonly AuditSessionRow[];
  onOpen: (threadId: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        no sessions in this range
      </p>
    );
  }
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-[11px] text-muted-foreground">
          <TextHead>thread</TextHead>
          <TextHead>seat</TextHead>
          <NumHead>turns</NumHead>
          <NumHead>tool calls</NumHead>
          <NumHead>tokens</NumHead>
          <NumHead>cost usd</NumHead>
          <NumHead>errors</NumHead>
          <NumHead>compactions</NumHead>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.threadId} className="border-t border-border">
            <td className="h-6 max-w-[260px] truncate px-2 py-0">
              <button
                type="button"
                className="block w-full truncate text-left underline underline-offset-2"
                onClick={() => onOpen(row.threadId)}
              >
                {row.title ?? row.threadId}
              </button>
            </td>
            <td className="h-6 px-2 py-0 text-muted-foreground">
              {row.seat ?? UNKNOWN}
            </td>
            <Num>{formatCount(row.turns)}</Num>
            <Num>{formatCount(row.toolCalls)}</Num>
            <Num>{formatTokens(row.tokens)}</Num>
            <Num>{formatUsd(row.costUsd)}</Num>
            <Num>{formatCount(row.providerErrors)}</Num>
            <Num>{formatCount(row.compactions)}</Num>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The two export formats the audit module renders. The button reports the
 * filename the server chose once the download starts, and reports a failure
 * on the same line rather than producing an empty file.
 */
function ExportActions({ threadId }: { threadId: string }) {
  const [note, setNote] = useState<string | null>(null);

  const run = useCallback(
    async (format: "json" | "md") => {
      setNote(null);
      try {
        const result = await callModule<AuditExport>(
          "observatory_audit_export",
          { threadId, format },
        );
        const url = URL.createObjectURL(
          new Blob([result.content], { type: "text/plain" }),
        );
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = result.filename;
        anchor.click();
        URL.revokeObjectURL(url);
        setNote(result.filename);
      } catch (error) {
        setNote(error instanceof Error ? error.message : "export unavailable");
      }
    },
    [threadId],
  );

  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="text-muted-foreground">export</span>
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={() => void run("json")}
      >
        audit.json
      </button>
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={() => void run("md")}
      >
        audit.md
      </button>
      {note === null ? null : (
        <span className="text-muted-foreground">{note}</span>
      )}
    </div>
  );
}

function MetricTable({ session }: { session: AuditSessionView }) {
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-[11px] text-muted-foreground">
          <TextHead>metric</TextHead>
          <NumHead>value</NumHead>
          <NumHead>7d median</NumHead>
          <NumHead>delta</NumHead>
        </tr>
      </thead>
      <tbody>
        {session.metrics.map((metric) => (
          <tr key={metric.metric} className="border-t border-border">
            <td className="h-6 px-2 py-0">{metric.metric}</td>
            <Num>{formatMetric(metric.metric, metric.value)}</Num>
            <Num>{formatMetric(metric.metric, metric.median)}</Num>
            <Num>{formatDelta(metric.delta)}</Num>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UnverifiedEdits({ session }: { session: AuditSessionView }) {
  if (session.unverifiedEdits.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground">
        every edit was followed by a command
      </p>
    );
  }
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-[11px] text-muted-foreground">
          <TextHead>unverified edit</TextHead>
          <TextHead>at</TextHead>
        </tr>
      </thead>
      <tbody>
        {session.unverifiedEdits.map((edit) => (
          <tr key={edit.itemId} className="border-t border-border">
            <td
              className="h-6 max-w-[420px] truncate px-2 py-0"
              title={edit.path ?? undefined}
            >
              {edit.path ?? edit.itemId}
            </td>
            <td className="h-6 px-2 py-0 text-muted-foreground tabular-nums">
              {formatTime(edit.at)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SessionDetail({ threadId }: { threadId: string }) {
  const query = useModuleQuery<AuditSessionView>(
    "observatory_audit_session",
    { threadId },
    fixtureAuditSession,
  );

  return (
    <QueryFrame query={query}>
      {(session) => (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold">
              {session.threadId ?? threadId}
            </h3>
            <ExportActions threadId={threadId} />
          </div>
          <HeroRow>
            <Hero
              label="verification detected"
              value={verificationVerdict(session.verification)}
            />
            <Hero
              label="unverified edits"
              value={formatCount(session.unverifiedEdits.length)}
            />
            <Hero
              label="commands"
              value={formatCount(session.verification.commands)}
            />
            <Hero
              label="threads"
              value={formatCount(session.threads.length)}
            />
          </HeroRow>
          <p className="text-[11px] text-muted-foreground">
            last verified {formatTime(session.verification.lastVerifiedAt)},
            run folder {session.runFolder ?? UNKNOWN}
          </p>
          <MetricTable session={session} />
          <h4 className="text-[13px] font-semibold">Findings</h4>
          {session.findings.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              nothing this session did crossed a finding rule
            </p>
          ) : (
            <ul className="flex flex-col gap-1 text-[13px]">
              {session.findings.map((finding) => (
                <li key={finding.code} className="border-t border-border pt-1">
                  <span className="font-semibold">{finding.code}</span>{" "}
                  <span className="text-muted-foreground">
                    {finding.detail}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <h4 className="text-[13px] font-semibold">Unverified edits</h4>
          <UnverifiedEdits session={session} />
        </div>
      )}
    </QueryFrame>
  );
}

/** One thread's audit as a thread tab: the detail without the list above it. */
export function ThreadAudit({ threadId }: { threadId: string }) {
  return (
    <section className="flex flex-col gap-3 py-4">
      <Heading>Audit</Heading>
      <SessionDetail threadId={threadId} />
    </section>
  );
}

export function AuditSessions({ threadId }: { threadId?: string }) {
  const navigate = useBbNavigate();
  const [range, setRange] = useState<SpendRange>("7d");
  const query = useModuleQuery<{ rows: AuditSessionRow[] }>(
    "observatory_audit_sessions",
    { range },
    fixtureAuditSessions,
  );

  const open = useCallback(
    (id: string) =>
      navigate.toPluginPanel(PANEL_PATH, { subPath: `audit/sessions/${id}` }),
    [navigate],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <RangeSelect value={range} onChange={setRange} />
      </div>
      <QueryFrame query={query}>
        {(data) => <SessionTable rows={data.rows} onOpen={open} />}
      </QueryFrame>
      {threadId === undefined ? null : <SessionDetail threadId={threadId} />}
    </div>
  );
}
