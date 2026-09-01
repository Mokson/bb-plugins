// The one line the composer shows on a stalled thread.
//
// It is a banner rather than a notification because the reader is already
// looking at this thread: the useful thing is not to be told, it is to be told
// what the evidence was and given the trajectory in one click.
//
// The banner follows the realtime channel, so it disappears the moment the
// signal closes. It renders nothing at all when there is no open watch signal
// for this thread - a composer that grows an empty strip on every thread is a
// worse composer.
import { useCallback, useState } from "react";
import {
  useBbNavigate,
  useComposerView,
  useRealtime,
} from "@get-bb/plugin-sdk/app";
import { formatSilence } from "@/lib/format";
import { useWatchQuery } from "@/lib/watch-rpc";
import { fixtureWatchList } from "@/fixtures/watch";
import { PANEL_PATH } from "@/pages/routes";
import {
  WATCH_SIGNAL_CHANNEL,
  type WatchList,
} from "../../watch/contract.js";

/** The thread this composer writes to, or null in a projectless compose. */
function composerThreadId(scope: ReturnType<typeof useComposerView>["scope"]): string | null {
  switch (scope.kind) {
    case "thread":
    case "queued-message":
      return scope.threadId;
    case "side-chat":
      return scope.childThreadId;
    default:
      return null;
  }
}

export function StallBanner() {
  const view = useComposerView();
  const navigate = useBbNavigate();
  const threadId = composerThreadId(view.scope);
  const [nonce, setNonce] = useState(0);

  // Any signal event may have opened or closed this thread's stall, so re-read
  // rather than trusting the event's own payload to be about this thread.
  useRealtime(WATCH_SIGNAL_CHANNEL, () => setNonce((value) => value + 1));

  const list = useWatchQuery<WatchList>(
    "observatory_watch_list",
    {},
    fixtureWatchList,
    nonce,
  );

  const openTrajectory = useCallback(() => {
    if (threadId === null) return;
    navigate.toPluginPanel(PANEL_PATH, {
      subPath: `threads/${threadId}/trajectory`,
    });
  }, [navigate, threadId]);

  if (threadId === null || list.kind !== "ready") return null;
  const row = list.data.rows.find(
    (candidate) =>
      candidate.threadId === threadId && candidate.state === "stalled",
  );
  if (row === undefined) return null;

  return (
    <div className="flex h-6 items-center gap-3 text-[13px]">
      <span>
        stalled {formatSilence(row.silentMs)}
        {row.diagnostic === null ? "" : `: ${row.diagnostic}`}
      </span>
      <button
        type="button"
        className="whitespace-nowrap underline underline-offset-2"
        onClick={openTrajectory}
      >
        open trajectory
      </button>
    </div>
  );
}
