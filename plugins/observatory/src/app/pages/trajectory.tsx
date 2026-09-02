// One thread's trajectory: what it did, turn by turn, and what the detours
// cost.
//
// The data is a join of two rpcs - `observatory_spend_thread` for the turns
// and their bills, `observatory_watch_explain` for the signals and the ladder
// actions. Neither returns a trajectory on its own; `lib/trajectory.ts` owns
// the join so this file is a renderer.
//
// No chart. PRODUCT invariant 34 allows exactly three in the plugin and this
// page is not one of them: a trajectory is read as a sequence, which is what a
// table already is.
import { useCallback } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Heading, QueryFrame } from "@/components/watch-common";
import { formatTime, formatUsd, UNKNOWN } from "@/lib/format";
import {
  trajectoryTurns,
  wasteByRule,
  wasteEmptyMessage,
} from "@/lib/trajectory";
import { useModuleQuery } from "@/lib/module-rpc";
import { useWatchQuery } from "@/lib/watch-rpc";
import { fixtureThread } from "@/fixtures/spend";
import { fixtureWatchExplain } from "@/fixtures/watch";
import { PANEL_PATH } from "./routes.js";
import type { SpendThread } from "../../spend/contract.js";
import type { WatchExplain } from "../../watch/contract.js";

/** The tooltip on the control that phase 6 will wire up. */
export const DISTILLERY_TOOLTIP = "distillery arrives in phase 6";

function TurnTable({
  thread,
  explain,
}: {
  thread: SpendThread;
  explain: WatchExplain;
}) {
  const rows = trajectoryTurns(thread.turns, explain.signals);
  return (
    <table className="w-full text-[13px]">
      <thead>
        <tr className="text-[11px] text-muted-foreground">
          <th className="px-2 py-1 text-left font-normal">started</th>
          <th className="px-2 py-1 text-left font-normal">model</th>
          <th className="px-2 py-1 text-right font-normal tabular-nums">
            cost usd
          </th>
          <th className="px-2 py-1 text-left font-normal">markers</th>
          <th className="px-2 py-1 text-left font-normal">items</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ turn, markers, items }) => (
          <tr key={turn.turnId} className="border-t border-border">
            <td className="h-6 whitespace-nowrap px-2 py-0 tabular-nums">
              {formatTime(turn.startedAt)}
            </td>
            <td className="h-6 max-w-40 truncate px-2 py-0">
              {turn.modelReported ?? turn.modelRequested ?? UNKNOWN}
            </td>
            <td className="h-6 whitespace-nowrap px-2 py-0 text-right tabular-nums">
              {formatUsd(turn.costUsd)}
            </td>
            {/* Uppercase, not colour: invariant 34 forbids colour as
                hierarchy, and an uppercase word survives a screenshot. */}
            <td className="h-6 whitespace-nowrap px-2 py-0 font-semibold">
              {markers.length === 0 ? UNKNOWN : markers.join(" ")}
            </td>
            <td className="h-6 max-w-96 truncate px-2 py-0 text-muted-foreground">
              {items.length === 0 ? UNKNOWN : items.join(" · ")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * What each rule cost. Attribution, not a partition: a turn covered by two
 * rules counts under both, so the column does not sum to the thread's bill.
 * The line beneath says so rather than leaving the reader to discover it.
 */
function WasteTable({
  thread,
  explain,
}: {
  thread: SpendThread;
  explain: WatchExplain;
}) {
  const rows = wasteByRule(thread.turns, explain.signals);
  // The copy lives in `lib/trajectory.ts` beside the function whose emptiness
  // it explains, so the two cannot drift and the branch is testable without a
  // render.
  if (rows.length === 0) {
    return (
      <p className="text-[13px] text-muted-foreground">
        {wasteEmptyMessage(explain.signals.length)}
      </p>
    );
  }
  return (
    <>
      <table className="w-full text-[13px]">
        <caption className="pb-1 text-left text-[11px] text-muted-foreground">
          waste attribution
        </caption>
        <thead>
          <tr className="text-[11px] text-muted-foreground">
            <th className="px-2 py-1 text-left font-normal">rule</th>
            <th className="px-2 py-1 text-right font-normal tabular-nums">
              turns
            </th>
            <th className="px-2 py-1 text-right font-normal tabular-nums">
              cost usd
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.rule} className="border-t border-border">
              <td className="h-6 px-2 py-0">{row.rule}</td>
              <td className="h-6 px-2 py-0 text-right tabular-nums">
                {row.turns}
              </td>
              <td className="h-6 px-2 py-0 text-right tabular-nums">
                {formatUsd(row.costUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[11px] text-muted-foreground">
        A turn under two rules counts under both, so this does not sum to the
        thread total.
      </p>
    </>
  );
}

function ActionList({ explain }: { explain: WatchExplain }) {
  if (explain.actions.length === 0) return null;
  return (
    <table className="w-full text-[13px]">
      <caption className="pb-1 text-left text-[11px] text-muted-foreground">
        ladder actions
      </caption>
      <tbody>
        {explain.actions.map((action) => (
          <tr key={action.id} className="border-t border-border">
            <td className="h-6 whitespace-nowrap px-2 py-0 tabular-nums">
              {formatTime(action.at)}
            </td>
            <td className="h-6 whitespace-nowrap px-2 py-0">{action.action}</td>
            <td className="h-6 px-2 py-0 text-muted-foreground">
              {action.detail}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The Trajectory tab's content. Rendered by the panel's
 * `threads/<id>/trajectory` route and by the thread panel action's tab, so the
 * two cannot drift.
 */
export function Trajectory({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const thread = useModuleQuery<SpendThread>(
    "observatory_spend_thread",
    { threadId },
    fixtureThread,
  );
  const explain = useWatchQuery<WatchExplain>(
    "observatory_watch_explain",
    { threadId },
    fixtureWatchExplain,
  );

  const openDistillery = useCallback(() => {
    navigate.toPluginPanel(PANEL_PATH, { subPath: "distillery" });
  }, [navigate]);

  return (
    <section className="flex flex-col gap-3 py-4">
      <QueryFrame query={thread}>
        {(threadData) => (
          <QueryFrame query={explain}>
            {(explainData) => (
              <>
                <Heading>{threadData.thread.title}</Heading>
                <p className="text-[11px] text-muted-foreground">
                  seat {threadData.thread.seat ?? UNKNOWN} · {" "}
                  {explainData.signals.length} signals · {" "}
                  {threadData.turns.length} turns
                </p>
                <TurnTable thread={threadData} explain={explainData} />
                <WasteTable thread={threadData} explain={explainData} />
                <ActionList explain={explainData} />
                <button
                  type="button"
                  disabled
                  title={DISTILLERY_TOOLTIP}
                  onClick={openDistillery}
                  className="self-start text-[11px] text-muted-foreground opacity-50"
                >
                  send to distillery
                </button>
              </>
            )}
          </QueryFrame>
        )}
      </QueryFrame>
    </section>
  );
}
