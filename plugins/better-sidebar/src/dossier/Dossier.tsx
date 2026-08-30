import type { ReactNode } from "react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { RenderRow } from "../model/types";
import type { Dossier as DossierPayload } from "../server-contract";
import type { DossierState } from "./useDossier";
import { useSignalValue } from "./useRowSignals";

/**
 * B29-B32. Popover contents. Every backend-derived section is independently
 * omitted when its field is null (B31), and no section anywhere renders a
 * monetary figure (B30) — bb exposes no per-thread cost and this plugin never
 * estimates one.
 *
 * The identity fields come from the `RenderRow` the row already holds — the
 * title is the model's resolved one and the branch its untruncated label — so
 * this file neither subscribes to the thread list nor re-derives either.
 */
export function Dossier({
  row,
  state,
  variant = "rich",
}: {
  row: RenderRow;
  state: DossierState;
  /** B50's `tooltip` setting: `minimal` is the overflow fields, no backend. */
  variant?: "rich" | "minimal";
}) {
  const { thread } = row;
  const threadId = thread.id;
  const signal = useSignalValue(threadId);
  const data = state.status === "ready" ? state.data : null;

  return (
    <div
      className="flex w-72 flex-col gap-2 text-xs"
      data-better-sidebar-dossier={threadId}
    >
      <Identity thread={thread} title={row.title} />

      {/* B50: row 2 truncates the branch, so the full one is the single most
          useful field the overflow card can carry — in both variants. */}
      {row.workspaceLabel === null ? null : (
        <Field label="Branch">{row.workspaceLabel}</Field>
      )}

      {/* B29 (§7 ruling): model and effort are omitted together when the
          thread has never resolved execution options. */}
      {data?.execution ? (
        <Field label="Model">
          {data.execution.model} · {data.execution.reasoningLevel}
        </Field>
      ) : null}

      {signal?.modelFallback ? (
        <Section title="Model fallback">
          <Field label="From">{signal.modelFallback.originalModel}</Field>
          <Field label="To">{signal.modelFallback.fallbackModel}</Field>
          <Field label="Reason">{signal.modelFallback.reason}</Field>
        </Section>
      ) : null}

      <Section title="Timestamps">
        <Field label="Created">{absolute(thread.createdAt)}</Field>
        <Field label="Updated">{absolute(thread.updatedAt)}</Field>
      </Section>

      {variant === "rich" && data?.contextWindow ? (
        <ContextWindow window={data.contextWindow} />
      ) : null}

      {/* B31: an `economics: null` payload omits this section entirely —
          never a zero, never a dash. */}
      {variant === "rich" && data?.economics ? (
        <Section title="Tokens">
          <Field label="Total">{count(data.economics.total.totalTokens)}</Field>
          <Field label="Input">{count(data.economics.total.inputTokens)}</Field>
          <Field label="Cached input">
            {count(data.economics.total.cachedInputTokens)}
          </Field>
          <Field label="Output">{count(data.economics.total.outputTokens)}</Field>
          <Field label="Reasoning">
            {count(data.economics.total.reasoningOutputTokens)}
          </Field>
        </Section>
      ) : null}

      {state.status === "loading" ? (
        <div
          data-testid="dossier-skeleton"
          aria-hidden="true"
          className="h-8 animate-pulse rounded bg-muted"
        />
      ) : null}

      {/* Ruling 10: a rejected call renders one inline line and a retry, never
          an indefinite spinner. */}
      {state.status === "error" ? (
        <div className="flex items-center justify-between gap-2 text-destructive">
          <span role="alert">{state.error}</span>
          <button type="button" onClick={state.retry} className="underline">
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Identity({
  thread,
  title,
}: {
  thread: PluginSidebarThread;
  title: string;
}) {
  const activity = Object.entries(thread.activity).filter(([, value]) => value > 0);
  return (
    <div className="flex flex-col gap-1">
      {/* B50: the full title, which row 1 truncated. */}
      <div className="text-sm font-medium">{title}</div>
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
        <span data-dossier-indicator={thread.indicator}>
          {thread.indicatorLabel ?? thread.indicator}
        </span>
        {activity.map(([name, value]) => (
          <span key={name} data-dossier-activity={name}>
            {activityLabel(name)} {value}
          </span>
        ))}
      </div>
    </div>
  );
}

function ContextWindow({
  window: contextWindow,
}: {
  window: NonNullable<DossierPayload["contextWindow"]>;
}) {
  const { usedTokens, modelContextWindow, estimated } = contextWindow;
  if (usedTokens === null || modelContextWindow === null || modelContextWindow <= 0) {
    return null;
  }
  const ratio = Math.min(1, usedTokens / modelContextWindow);
  return (
    <Section title={estimated ? "Context window (estimated)" : "Context window"}>
      <div
        className="h-1.5 w-full overflow-hidden rounded bg-muted"
        role="meter"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Context window used"
      >
        <div className="h-full bg-foreground/60" style={{ width: `${ratio * 100}%` }} />
      </div>
      <Field label="Used">
        {count(usedTokens)} / {count(modelContextWindow)}
      </Field>
    </Section>
  );
}

function Section({ title: heading, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-muted-foreground/70 uppercase tracking-wide">{heading}</div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}

const ACTIVITY_LABELS: Record<string, string> = {
  workflows: "workflows",
  backgroundAgents: "background agents",
  backgroundCommands: "background commands",
  planMode: "plan mode",
  goals: "goals",
};

function activityLabel(name: string): string {
  return ACTIVITY_LABELS[name] ?? name;
}

function absolute(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

/** Plain integers with thousands separators. Never a currency figure (B30). */
function count(value: number): string {
  return value.toLocaleString("en-US");
}
