// The two numbers on the Observatory row in the sidebar.
//
// The slot is clipped to a small single-line box and shares the trailing
// action column, so this renders at most nine characters and never a control.
// Zero renders nothing rather than "0 stalled": a permanent zero trains the
// reader to stop looking at the spot where a real number will appear.
import { useState } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { useWatchQuery } from "@/lib/watch-rpc";
import { fixtureInbox } from "@/fixtures/watch";
import { WATCH_SIGNAL_CHANNEL, type Inbox } from "../../watch/contract.js";

export function NavAccessory() {
  const [nonce, setNonce] = useState(0);
  useRealtime(WATCH_SIGNAL_CHANNEL, () => setNonce((value) => value + 1));

  const query = useWatchQuery<Inbox>(
    "observatory_inbox",
    {},
    fixtureInbox,
    nonce,
  );
  if (query.kind !== "ready") return null;

  const { stalled, queue } = query.data.counts;
  const parts = [
    stalled > 0 ? `${stalled} stalled` : null,
    queue > 0 ? `${queue} queued` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;

  return (
    <span className="text-[11px] tabular-nums text-muted-foreground">
      {parts.join(" · ")}
    </span>
  );
}
