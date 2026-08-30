import type { ReactNode } from "react";
import { experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk";
import type { Dossier as DossierPayload } from "../server-contract";
import type { DossierState } from "./useDossier";
import { useSignalValue } from "./useRowSignals";

/**
 * B29-B32. Popover contents. Every backend-derived section is independently
 * omitted when its field is null (B31), and no section anywhere renders a
 * monetary figure (B30) — bb exposes no per-thread cost and this plugin never
 * estimates one.
 */
export function Dossier({
  threadId,
  state,
  variant = "rich",
}: {
  threadId: string;
  state: DossierState;
  /** B48's `tooltip` setting: `minimal` keeps identity, drops the numbers. */
  variant?: "rich" | "minimal";
}) {
  const threads = experimental_useSidebarThreads();
  const thread = threads.threads.find((candidate) => candidate.id === threadId) ?? null;
  const signal = useSignalValue(threadId);
  const data = state.status === "ready" ? state.data : null;

  return (
    <div
      className="flex w-72 flex-col gap-2 text-xs"
      data-better-sidebar-dossier={threadId}
    >
      {thread !== null ? <Identity thread={thread} /> : null}

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

      {thread !== null ? (
        <Section title="Timestamps">
          <Field label="Created">{absolute(thread.createdAt)}</Field>
          <Field label="Updated">{absolute(thread.updatedAt)}</Field>
        </Section>
      ) : null}

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

function Identity({ thread }: { thread: PluginSidebarThread }) {
  const activity = Object.entries(thread.activity).filter(([, value]) => value > 0);
  return (
    <div className="flex flex-col gap-1">
      <div className="text-sm font-medium">{title(thread)}</div>
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

function title(thread: PluginSidebarThread): string {
  const resolved = thread.title?.trim() || thread.titleFallback?.trim();
  return resolved && resolved.length > 0 ? resolved : "Untitled";
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
