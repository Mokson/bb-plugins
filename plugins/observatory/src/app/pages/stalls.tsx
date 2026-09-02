// The stall monitor.
//
// Stalled threads first, healthy ones folded away: the page exists to be
// scanned when something is wrong, and a healthy thread has nothing to say.
// The silence timer bar is the only chart here and one of exactly three in the
// plugin (PRODUCT invariant 34) - silence is read as "how far past the line",
// which a number alone makes the reader compute.
//
// There is no kill button and there will not be one. The plugin observes and
// advises; it never terminates agent work.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import {
  FilterBox,
  Heading,
  Hero,
  KeyHelp,
  QueryFrame,
} from "@/components/watch-common";
import { formatSilence, silenceRatio, UNKNOWN } from "@/lib/format";
import { useWatchQuery, useWatchSteer } from "@/lib/watch-rpc";
import { usePanelKeys } from "@/lib/use-panel-keys";
import { fixtureWatchList, fixtureWatchSettings } from "@/fixtures/watch";
import { PANEL_PATH } from "./routes.js";
import {
  WATCH_SIGNAL_CHANNEL,
  type WatchList,
  type WatchRow,
  type WatchSettings,
} from "../../watch/contract.js";

const BAR_WIDTH = 96;

/**
 * How long a thread may be silent before the silence rule fires, in
 * milliseconds. Read from the live thresholds so the bar and the rule cannot
 * disagree; `null` when the settings call has not answered, which draws no bar
 * rather than a bar against a guessed line.
 */
function silenceThresholdMs(settings: WatchSettings | null): number | null {
  // The key `src/watch/settings.ts` publishes for silence-no-inflight.
  const minutes = settings?.thresholds["watch_silenceMinutes"];
  return minutes === undefined ? null : minutes * 60_000;
}

/**
 * The silence timer bar: a hairline track with a filled span. No colour and no
 * fill pattern carries the meaning - the length does, and the number sits
 * beside it for the reader who needs the digits.
 */
function SilenceBar({
  silentMs,
  thresholdMs,
}: {
  silentMs: number;
  thresholdMs: number | null;
}) {
  if (thresholdMs === null) {
    return <span className="text-muted-foreground">{UNKNOWN}</span>;
  }
  const ratio = silenceRatio(silentMs, thresholdMs);
  return (
    <span
      className="inline-block border-b border-border align-middle"
      style={{ width: `${BAR_WIDTH}px` }}
      role="img"
      aria-label={`Silent ${formatSilence(silentMs)} against a ${formatSilence(thresholdMs)} threshold`}
    >
      <span
        className="block border-b border-foreground"
        style={{ width: `${Math.round(ratio * BAR_WIDTH)}px` }}
      />
    </span>
  );
}

function StallTable({
  rows,
  thresholdMs,
  selected,
  onSelect,
  onOpen,
  onAct,
  caption,
}: {
  rows: readonly WatchRow[];
  thresholdMs: number | null;
  selected: number;
  onSelect: (index: number) => void;
  onOpen: (row: WatchRow) => void;
  onAct: (action: "steer" | "escalate", row: WatchRow) => void;
  caption: string;
}) {
  return (
    // Fixed layout, so the diagnostic is the column that gets cut rather than
    // pushing the ones a reader scans first off the edge of a narrow panel.
    <table className="w-full table-fixed text-[13px]">
      <colgroup>
        <col className="w-[20%]" />
        <col className="w-[9ch]" />
        <col className="w-[8ch]" />
        <col className="w-[110px]" />
        <col className="w-[18%]" />
        <col className="w-[10ch]" />
        <col />
        <col className="w-[16ch]" />
      </colgroup>
      <caption className="pb-1 text-left text-[11px] text-muted-foreground">
        {caption}
      </caption>
      <thead>
        <tr className="text-[11px] text-muted-foreground">
          <th className="px-2 py-1 text-left font-normal">thread</th>
          <th className="px-2 py-1 text-left font-normal">seat</th>
          <th className="px-2 py-1 text-right font-normal tabular-nums">
            silent
          </th>
          <th className="px-2 py-1 text-left font-normal">timer</th>
          <th className="px-2 py-1 text-left font-normal">in flight</th>
          <th className="px-2 py-1 text-left font-normal">stage</th>
          <th className="px-2 py-1 text-left font-normal">last diagnostic</th>
          <th className="px-2 py-1 text-left font-normal">act</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr
            key={row.threadId}
            aria-selected={index === selected}
            className={
              index === selected
                ? "border-t border-border bg-foreground/5"
                : "border-t border-border"
            }
            onMouseEnter={() => onSelect(index)}
          >
            <td className="h-6 truncate px-2 py-0">
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => onOpen(row)}
              >
                {row.title}
              </button>
            </td>
            <td className="h-6 whitespace-nowrap px-2 py-0">
              {row.seat ?? UNKNOWN}
            </td>
            <td className="h-6 whitespace-nowrap px-2 py-0 text-right tabular-nums">
              {formatSilence(row.silentMs)}
            </td>
            <td className="h-6 px-2 py-0">
              <SilenceBar silentMs={row.silentMs} thresholdMs={thresholdMs} />
            </td>
            <td className="h-6 truncate px-2 py-0">
              {row.inflight === null
                ? UNKNOWN
                : `${row.inflight.kind} ${row.inflight.name}`}
            </td>
            <td className="h-6 whitespace-nowrap px-2 py-0">
              {row.stage ?? UNKNOWN}
            </td>
            <td className="h-6 truncate px-2 py-0 text-muted-foreground">
              {row.diagnostic ?? UNKNOWN}
            </td>
            {/* Text, not icons: invariant 34 rules out a colour-coded or
                pictographic hierarchy, and two words are unambiguous where two
                glyphs would need a legend. There is deliberately no stop. */}
            <td className="h-6 whitespace-nowrap px-2 py-0">
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => onAct("steer", row)}
              >
                steer
              </button>
              {" · "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => onAct("escalate", row)}
              >
                escalate
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StallsPage() {
  const navigate = useBbNavigate();
  const [nonce, setNonce] = useState(0);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const steer = useWatchSteer();
  const filterRef = useRef<HTMLInputElement | null>(null);

  useRealtime(WATCH_SIGNAL_CHANNEL, () => setNonce((value) => value + 1));

  const list = useWatchQuery<WatchList>(
    "observatory_watch_list",
    {},
    fixtureWatchList,
    nonce,
  );
  const settings = useWatchQuery<WatchSettings>(
    "observatory_watch_settings_get",
    {},
    fixtureWatchSettings,
  );
  const thresholdMs = silenceThresholdMs(
    settings.kind === "ready" ? settings.data : null,
  );

  const all = list.kind === "ready" ? list.data.rows : [];
  const matching = useMemo(
    () =>
      all.filter((row) =>
        `${row.title} ${row.seat ?? ""} ${row.rule ?? ""}`
          .toLowerCase()
          .includes(filter.trim().toLowerCase()),
      ),
    [all, filter],
  );
  // Longest silence first inside each group: the worst stall is the one the
  // reader has been ignoring longest.
  const stalled = useMemo(
    () =>
      matching
        .filter((row) => row.state === "stalled")
        .sort((left, right) => right.silentMs - left.silentMs),
    [matching],
  );
  const healthy = useMemo(
    () =>
      matching
        .filter((row) => row.state !== "stalled")
        .sort((left, right) => right.silentMs - left.silentMs),
    [matching],
  );
  const navigable = useMemo(
    () => (showAll ? [...stalled, ...healthy] : stalled),
    [showAll, stalled, healthy],
  );

  useEffect(() => {
    setSelected((index) => Math.min(index, Math.max(0, navigable.length - 1)));
  }, [navigable.length]);

  const open = useCallback(
    (row: WatchRow) => navigate.toThread(row.threadId),
    [navigate],
  );

  // One line, from the server's own vocabulary. A refusal ("watch mode is
  // observe; set it to steer first") is as much a result as a success, and
  // both land in the same place so a click always answers.
  const act = useCallback(
    (action: "steer" | "escalate", row: WatchRow) => {
      setConfirmation(`${action}ing ${row.threadId}...`);
      void steer(action, row.threadId).then((message) => {
        setConfirmation(message);
        // A steer writes an action row and may close or open a signal, so the
        // list is re-read rather than left showing the state before the click.
        setNonce((value) => value + 1);
      });
    },
    [steer],
  );

  usePanelKeys(
    useCallback(
      (action) => {
        switch (action.kind) {
          case "navigate":
            navigate.toPluginPanel(PANEL_PATH, { subPath: action.route });
            return;
          case "focus-filter":
            filterRef.current?.focus();
            return;
          case "move":
            setSelected((index) =>
              navigable.length === 0
                ? 0
                : Math.min(
                    navigable.length - 1,
                    Math.max(0, index + action.delta),
                  ),
            );
            return;
          case "activate": {
            const row = navigable[selected];
            if (row !== undefined) open(row);
            return;
          }
          case "dismiss":
            filterRef.current?.blur();
            setHelpOpen(false);
            return;
          case "toggle-help":
            setHelpOpen((value) => !value);
        }
      },
      [navigate, navigable, selected, open],
    ),
  );

  return (
    <section className="flex flex-col gap-3 py-4">
      <Heading>Stalls</Heading>
      <QueryFrame query={list}>
        {(data) => (
          <>
            <div className="grid grid-cols-4 gap-6">
              <Hero label="watched" value={String(data.watched)} />
              <Hero label="stalled" value={String(stalled.length)} />
            </div>
            <FilterBox
              value={filter}
              onChange={setFilter}
              inputRef={filterRef}
              placeholder="filter, / to focus"
            />
            {stalled.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                No thread is stalled.
              </p>
            ) : (
              <StallTable
                rows={stalled}
                thresholdMs={thresholdMs}
                selected={selected}
                onSelect={setSelected}
                onOpen={open}
                onAct={act}
                caption="stalled"
              />
            )}
            <button
              type="button"
              className="self-start text-[11px] text-muted-foreground underline underline-offset-2"
              onClick={() => setShowAll((value) => !value)}
            >
              {showAll ? "hide healthy" : `show all (${healthy.length} healthy)`}
            </button>
            {showAll && healthy.length > 0 ? (
              <StallTable
                rows={healthy}
                thresholdMs={thresholdMs}
                selected={selected - stalled.length}
                onSelect={(index) => setSelected(index + stalled.length)}
                onOpen={open}
                onAct={act}
                caption="healthy"
              />
            ) : null}
            {confirmation === null ? null : (
              <p
                role="status"
                className="text-[11px] text-muted-foreground"
              >
                {confirmation}
              </p>
            )}
            <KeyHelp open={helpOpen} />
          </>
        )}
      </QueryFrame>
    </section>
  );
}
