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
      className={
        // The same popover surface DisplayMenu, PrChip and RowContextMenu
        // draw. Without it the card is transparent over the thread list.
        "flex w-72 flex-col gap-1.5 rounded-lg border border-border bg-popover" +
        " p-2 text-xs text-popover-foreground shadow-md"
      }
      data-better-sidebar-dossier={threadId}
    >
      <Identity thread={thread} title={row.title} />

      {/* Branch and model are one section rather than two loose fields: every
          row in the card now sits under a heading, so there is one field
          style instead of two. The section is omitted whole when neither
          field resolves. */}
      {row.workspaceLabel === null && !data?.execution ? null : (
        <Section title="Thread">
          {/* B50: row 2 truncates the branch, so the full one is the single
              most useful field the overflow card can carry. */}
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
        </Section>
      )}

      {signal?.modelFallback ? (
        <Section title="Model fallback">
          <Field label="From">{signal.modelFallback.originalModel}</Field>
          <Field label="To">{signal.modelFallback.fallbackModel}</Field>
          <Field label="Reason">{signal.modelFallback.reason}</Field>
        </Section>
      ) : null}

      <Section title="Timestamps">
        <Field label="Created">{shortLocal(thread.createdAt)}</Field>
        <Field label="Updated">{shortLocal(thread.updatedAt)}</Field>
      </Section>

      {variant === "rich" && data?.contextWindow ? (
        <ContextWindow window={data.contextWindow} />
      ) : null}

      {/* B31: an `economics: null` payload omits this section entirely —
          never a zero, never a dash. */}
      {variant === "rich" && data?.economics ? (
        <Section title="Tokens">
          <Field label="Total">{compact(data.economics.total.totalTokens)}</Field>
          <Field label="Input">{compact(data.economics.total.inputTokens)}</Field>
          <Field label="Cached input">
            {compact(data.economics.total.cachedInputTokens)}
          </Field>
          <CacheHit total={data.economics.total} />
          <Field label="Output">{compact(data.economics.total.outputTokens)}</Field>
          {/* A zero spends a row to say nothing. Every other count in this
              section is present whatever its value, because a real zero there
              is a measurement; reasoning output is simply absent on the
              providers that never emit it. */}
          {data.economics.total.reasoningOutputTokens === 0 ? null : (
            <Field label="Reasoning">
              {compact(data.economics.total.reasoningOutputTokens)}
            </Field>
          )}
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
        {/* `indicatorLabel` is null exactly when the indicator is "none", and
            the raw key was being printed in its place — the word "none" on
            every idle thread, which is most of them. Idle draws nothing here
            for the same reason the row's glyph draws nothing for it. */}
        {thread.indicator === "none" ? null : (
          <span data-dossier-indicator={thread.indicator}>
            {thread.indicatorLabel ?? thread.indicator}
          </span>
        )}
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
    <Section title="Context window">
      <div
        className="mt-0.5 mb-1 h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Context window used"
      >
        <div
          className="h-full rounded-full bg-foreground/60"
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      {/* The percentage leads, because it is what the meter above it means.
          The counts follow it as the detail, not as the answer.

          "estimated" rides on the label rather than the section heading it
          used to shout from, and rather than the orphan line under the row it
          qualifies. It describes this number, so it sits with it. */}
      <Field label={estimated ? "Used (est.)" : "Used"}>
        <span className="font-medium">{percent(ratio)}</span>
        <span className="text-muted-foreground">
          {` · ${compact(usedTokens)} / ${compact(modelContextWindow)}`}
        </span>
      </Field>
    </Section>
  );
}

/**
 * A titled group. The heading is deliberately quieter than the rows it labels
 * — it was drawn at the same size as the data, so `TIMESTAMPS` competed with
 * the timestamps. The rule above it does the separating that the shouting
 * used to attempt.
 */
function Section({ title: heading, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-t border-border/60 pt-1.5">
      <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground/60">
        {heading}
      </div>
      {children}
    </div>
  );
}

/**
 * One label/value row. The value is right-aligned and wraps.
 *
 * A long branch is the case this is built for: it is the one field that has
 * to be shown in full, so it wraps rather than truncates. Left-aligned, its
 * second line started at a different x from the first and broke the right
 * edge every other row shares — `text-right` keeps that edge, and
 * `break-words` lets an unbroken token wrap rather than overflow the card.
 * The label never compresses, so the two columns stay put.
 */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right">{children}</span>
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

/**
 * The reader's own timezone, to the minute: `30 Aug 19:45`, or
 * `30 Aug 2025 19:45` once the year stops being this one.
 *
 * The card used to print `2026-08-30 19:45:28 UTC`. Seconds are noise on a
 * thread timestamp, and UTC made every reader do the offset in their head.
 */
function shortLocal(epochMs: number): string {
  const date = new Date(epochMs);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: sameYear ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * B31: omitted rather than shown as 0% when the thread has read no input at
 * all, which is the same "no data" the section's own null case covers.
 */
function CacheHit({
  total,
}: {
  total: { inputTokens: number; cachedInputTokens: number };
}) {
  const rate = cacheHitRate(total);
  if (rate === null) return null;
  return <Field label="Cache hit">{percent(rate)}</Field>;
}

/**
 * The share of input tokens served from cache, or null when the thread has
 * read no input.
 *
 * `inputTokens` EXCLUDES cache reads — on a real payload
 * `input + cachedInput + output` sums to `totalTokens` exactly — so the two
 * fields together are the whole input and the ratio is over their sum, never
 * over `totalTokens`, which output would dilute.
 */
export function cacheHitRate(total: {
  inputTokens: number;
  cachedInputTokens: number;
}): number | null {
  const read = total.inputTokens + total.cachedInputTokens;
  if (read <= 0) return null;
  return total.cachedInputTokens / read;
}

/**
 * One decimal, FLOORED rather than rounded. A real thread reading 170,088,977
 * cached against 888 uncached is at 99.99948%, which rounds to a flat "100%"
 * — a figure that claims every token came from cache. Flooring keeps 100.0%
 * for the only case that earns it: no uncached input at all.
 */
function percent(ratio: number): string {
  return `${(Math.floor(ratio * 1000) / 10).toFixed(1)}%`;
}

/**
 * Three significant digits with a magnitude suffix: `30.6M`, `96.7K`, `404`.
 *
 * A 288px card carrying five nine-digit counts is a wall of commas that reads
 * as noise. Under 10,000 the exact number is short enough to keep, and it is
 * also the range where a rounded figure would lose real precision.
 * Never a currency figure (B30).
 */
function compact(value: number): string {
  if (value < 10_000) return value.toLocaleString("en-US");
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}
