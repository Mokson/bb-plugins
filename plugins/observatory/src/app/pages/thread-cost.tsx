// One thread's cost: the cost-by-turn sparkline and the turn table.
//
// The sparkline is the only chart on this page and one of exactly three in the
// plugin (PRODUCT invariant 34). It exists because a bill is read as a shape
// first - which turn spiked - and a table cannot show that at a glance. Every
// bar is a button: a spike is where a cache miss usually is, so clicking one
// lands on that thread's cache drilldown.
import { useCallback } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Heading, Heroes, Num, NumHead, QueryFrame, TextHead } from "@/components/spend-common";
import {
  formatDuration,
  formatTime,
  formatTokens,
  formatUsd,
  UNKNOWN,
} from "@/lib/format";
import { useSpendQuery } from "@/lib/spend-rpc";
import { fixtureThread } from "@/fixtures/spend";
import { PANEL_PATH } from "./routes.js";
import type { SpendThread, TurnRow } from "../../spend/contract.js";

const SPARK_HEIGHT = 40;

/**
 * Cost by turn, one bar per turn, scaled to the most expensive turn in the
 * thread. A turn with no cost renders as a hairline baseline rather than a
 * zero-height gap, so an unpriced turn still occupies its position.
 */
function Sparkline({
  turns,
  onSelect,
}: {
  turns: readonly TurnRow[];
  onSelect: () => void;
}) {
  const peak = turns.reduce(
    (highest, turn) => Math.max(highest, turn.costUsd ?? 0),
    0,
  );

  return (
    <div
      className="flex items-end gap-px border-b border-border"
      style={{ height: `${SPARK_HEIGHT}px` }}
      role="group"
      aria-label="Cost by turn"
    >
      {turns.map((turn) => {
        const cost = turn.costUsd ?? 0;
        const height = peak <= 0 ? 1 : Math.max(1, (cost / peak) * SPARK_HEIGHT);
        return (
          <button
            key={turn.turnId}
            type="button"
            className="w-2 bg-foreground/60 hover:bg-foreground"
            style={{ height: `${height}px` }}
            title={`${turn.turnId} ${formatUsd(turn.costUsd)} usd`}
            aria-label={`Turn ${turn.turnId}, ${formatUsd(turn.costUsd)} usd`}
            onClick={onSelect}
          />
        );
      })}
    </div>
  );
}

function TurnTable({ turns }: { turns: readonly TurnRow[] }) {
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-[11px] text-muted-foreground">
          <TextHead>started</TextHead>
          <TextHead>model</TextHead>
          <TextHead>effort</TextHead>
          <NumHead>dur</NumHead>
          <NumHead>input tok</NumHead>
          <NumHead>cache read tok</NumHead>
          <NumHead>cache write tok</NumHead>
          <NumHead>output tok</NumHead>
          <NumHead>cost usd</NumHead>
          <TextHead>split</TextHead>
          <TextHead>flags</TextHead>
        </tr>
      </thead>
      <tbody>
        {turns.map((turn) => (
          <tr key={turn.turnId} className="border-t border-border">
            <td className="h-6 whitespace-nowrap px-2 py-0 tabular-nums">
              {formatTime(turn.startedAt)}
            </td>
            <td className="h-6 max-w-40 truncate whitespace-nowrap px-2 py-0">
              {turn.modelReported ?? turn.modelRequested ?? UNKNOWN}
            </td>
            <td className="h-6 whitespace-nowrap px-2 py-0">{turn.effort ?? UNKNOWN}</td>
            <Num>{formatDuration(turn.durationMs)}</Num>
            <Num>{formatTokens(turn.inputTokens)}</Num>
            <Num>{formatTokens(turn.cacheReadTokens)}</Num>
            <Num>{formatTokens(turn.cacheWriteTokens)}</Num>
            <Num>{formatTokens(turn.outputTokens)}</Num>
            <Num>{formatUsd(turn.costUsd)}</Num>
            <td className="h-6 whitespace-nowrap px-2 py-0">{turn.splitSource}</td>
            <td className="h-6 max-w-40 truncate whitespace-nowrap px-2 py-0 text-muted-foreground">
              {turn.flags.length === 0 ? UNKNOWN : turn.flags.join(" ")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The Cost tab's content. Rendered by the panel's `threads/<id>` route and by
 * the thread panel action's tab, so the two cannot drift.
 */
export function ThreadCost({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const query = useSpendQuery<SpendThread>(
    "observatory_spend_thread",
    { threadId },
    fixtureThread,
  );

  // The drilldown is scoped by thread, not by turn: a miss is a property of
  // the pair of turns that straddle it, and the thread's list already carries
  // the clicked turn.
  const openCacheDrilldown = useCallback(() => {
    navigate.toPluginPanel(PANEL_PATH, { subPath: `cost/cache/${threadId}` });
  }, [navigate, threadId]);

  return (
    <section className="flex flex-col gap-3 py-4">
      <QueryFrame query={query}>
        {(data) => (
          <>
            <Heading>{data.thread.title}</Heading>
            <p className="text-[11px] text-muted-foreground">
              {data.thread.provider} · seat {data.thread.seat ?? UNKNOWN} · tier{" "}
              {data.thread.tier ?? UNKNOWN} · run{" "}
              {data.thread.runFolder ?? UNKNOWN}
            </p>
            <Heroes totals={data.totals} />
            <Sparkline turns={data.turns} onSelect={openCacheDrilldown} />
            <TurnTable turns={data.turns} />
          </>
        )}
      </QueryFrame>
    </section>
  );
}
