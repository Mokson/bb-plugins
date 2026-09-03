import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useBbNavigate,
  useRealtime,
  useRpc,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { clockTime, progressLabel, relativeAge } from "../format";
import { countBySkill, type InvocationStatus } from "../model";
import { INDEX_CHANNEL, skillUsageRpcContract } from "../skill-usage-contract";

type Scope = "thread" | "project" | "global";

const SCOPES: ReadonlyArray<{ id: Scope; label: string }> = [
  { id: "thread", label: "Thread" },
  { id: "project", label: "Project" },
  { id: "global", label: "All" },
];

interface Invocation {
  itemId: string;
  threadId: string;
  seq: number;
  createdAt: number;
  skill: string;
  args: string | null;
  status: InvocationStatus;
  result: string | null;
}

interface RollupThread {
  threadId: string;
  title: string | null;
  count: number;
  lastUsedAt: number;
}

interface RollupRow {
  skill: string;
  total: number;
  failures: number;
  lastUsedAt: number;
  threads: RollupThread[];
}

interface IndexStatus {
  running: boolean;
  done: number;
  total: number;
  indexedThreads: number;
  lastRefreshAt: number | null;
  error: string | null;
}

function StatusDot({ status }: { status: InvocationStatus }) {
  const tone =
    status === "failed"
      ? "bg-red-500"
      : status === "running"
        ? "bg-amber-500 animate-pulse"
        : "bg-emerald-500";
  return (
    <span
      className={`mt-1.5 inline-block size-1.5 shrink-0 rounded-full ${tone}`}
      aria-label={status}
    />
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-6 text-center text-xs text-muted-foreground">{children}</p>;
}

function ThreadScope({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof skillUsageRpcContract>();
  const [invocations, setInvocations] = useState<Invocation[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const result = await rpc.call("threadInvocations", { threadId });
      if (mounted.current) {
        setInvocations(result.invocations as Invocation[]);
        setError(null);
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc, threadId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // Live tail. Each server-held wait resolves on the next item event past the
  // highest sequence seen, or times out; either way the loop asks again while
  // the panel is mounted, and stops the moment it is not.
  const highestSeq = invocations?.reduce((max, item) => Math.max(max, item.seq), 0) ?? 0;
  useEffect(() => {
    if (invocations === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await rpc.call("waitThread", { threadId, afterSeq: highestSeq });
        if (cancelled) return;
        if (result.changed) await load();
        else if (mounted.current) setInvocations((current) => (current === null ? null : [...current]));
      } catch {
        // A failed wait must not spin: the panel refreshes on next open.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, highestSeq, invocations, load]);

  const summary = useMemo(() => countBySkill(invocations ?? []), [invocations]);

  if (error !== null) return <EmptyState>Could not read this thread: {error}</EmptyState>;
  if (invocations === null) return <EmptyState>Reading thread…</EmptyState>;
  if (invocations.length === 0) return <EmptyState>No skills used in this thread yet.</EmptyState>;

  return (
    <div className="flex flex-col">
      <p className="px-3 py-2 text-xs text-muted-foreground">
        {invocations.length} invocation{invocations.length === 1 ? "" : "s"} ·{" "}
        {summary.length} skill{summary.length === 1 ? "" : "s"}
      </p>
      <ul className="flex flex-col">
        {invocations.map((invocation) => {
          const open = expanded === invocation.itemId;
          return (
            <li key={invocation.itemId} className="border-t border-border/50">
              <button
                type="button"
                onClick={() => setExpanded(open ? null : invocation.itemId)}
                aria-expanded={open}
                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-muted/50"
              >
                <StatusDot status={invocation.status} />
                <span className="min-w-0 flex-1 truncate text-sm">{invocation.skill}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {clockTime(invocation.createdAt)}
                </span>
              </button>
              {open ? (
                <dl className="space-y-1 px-3 pb-3 pl-7 text-xs text-muted-foreground">
                  <div>
                    <dt className="inline font-medium">Status: </dt>
                    <dd className="inline">{invocation.status}</dd>
                  </div>
                  {invocation.args !== null ? (
                    <div>
                      <dt className="inline font-medium">Args: </dt>
                      <dd className="inline break-words">{invocation.args}</dd>
                    </div>
                  ) : null}
                  {invocation.result !== null ? (
                    <div>
                      <dt className="inline font-medium">Result: </dt>
                      <dd className="inline break-words">{invocation.result}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RollupScope({ scope, threadId }: { scope: "project" | "global"; threadId: string }) {
  const rpc = useRpc<typeof skillUsageRpcContract>();
  const navigate = useBbNavigate();
  const [rows, setRows] = useState<RollupRow[] | null>(null);
  const [status, setStatus] = useState<IndexStatus | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const loadRows = useCallback(async () => {
    try {
      const result = await rpc.call("rollup", { scope, threadId });
      if (mounted.current) {
        setRows(result.skills as RollupRow[]);
        setError(null);
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [rpc, scope, threadId]);

  // Opening a rollup is the only refresh trigger: no cron, no background
  // service. The first open backfills, later opens only catch up.
  useEffect(() => {
    mounted.current = true;
    void (async () => {
      await loadRows();
      try {
        const next = await rpc.call("indexRefresh", {});
        if (mounted.current) setStatus(next as IndexStatus);
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, [loadRows, rpc]);

  useRealtime(INDEX_CHANNEL, (payload) => {
    if (!mounted.current || payload === null || typeof payload !== "object") return;
    const next = payload as IndexStatus;
    setStatus(next);
    // Refetch as the pass advances so the list fills in rather than appearing
    // whole at the end, and once more when the pass finishes.
    void loadRows();
  });

  const rebuild = useCallback(async () => {
    setRows(null);
    const next = await rpc.call("indexRefresh", { rebuild: true });
    if (mounted.current) setStatus(next as IndexStatus);
  }, [rpc]);

  const progress = status === null ? null : progressLabel(status.done, status.total);
  const now = Date.now();

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <p className="min-w-0 truncate text-xs text-muted-foreground">
          {status !== null && status.running
            ? `Indexing ${progress ?? "…"}`
            : `${status?.indexedThreads ?? 0} threads indexed`}
        </p>
        <button
          type="button"
          onClick={() => void rebuild()}
          disabled={status?.running === true}
          className="shrink-0 rounded border border-border px-2 py-0.5 text-xs hover:bg-muted/50 disabled:opacity-50"
        >
          Rebuild index
        </button>
      </div>
      {status?.error != null ? (
        <p className="px-3 pb-2 text-xs text-red-500">Index error: {status.error}</p>
      ) : null}
      {error !== null ? <EmptyState>Could not load the rollup: {error}</EmptyState> : null}
      {rows !== null && rows.length === 0 && status?.running !== true ? (
        <EmptyState>No skill invocations indexed yet.</EmptyState>
      ) : null}
      <ul className="flex flex-col">
        {(rows ?? []).map((row) => {
          const open = expanded === row.skill;
          return (
            <li key={row.skill} className="border-t border-border/50">
              <button
                type="button"
                onClick={() => setExpanded(open ? null : row.skill)}
                aria-expanded={open}
                className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
              >
                <span className="min-w-0 flex-1 truncate text-sm">{row.skill}</span>
                {row.failures > 0 ? (
                  <span className="shrink-0 text-xs text-red-500">{row.failures} failed</span>
                ) : null}
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {row.total}
                </span>
                <span className="w-8 shrink-0 text-right text-xs text-muted-foreground">
                  {relativeAge(row.lastUsedAt, now)}
                </span>
              </button>
              {open ? (
                <ul className="pb-1">
                  {row.threads.map((thread) => (
                    <li key={thread.threadId}>
                      <button
                        type="button"
                        onClick={() => navigate.toThread(thread.threadId)}
                        className="flex w-full items-center gap-2 py-1 pl-7 pr-3 text-left text-xs hover:bg-muted/50"
                      >
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {thread.title ?? thread.threadId}
                        </span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {thread.count}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function SkillUsagePanel({ threadId }: PluginThreadPanelProps) {
  const [scope, setScope] = useState<Scope>("thread");
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex gap-1 p-2" role="tablist" aria-label="Skill usage scope">
        {SCOPES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={scope === entry.id}
            onClick={() => setScope(entry.id)}
            className={`flex-1 rounded px-2 py-1 text-xs ${
              scope === entry.id ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {scope === "thread" ? (
        <ThreadScope threadId={threadId} />
      ) : (
        <RollupScope scope={scope} threadId={threadId} />
      )}
    </div>
  );
}
